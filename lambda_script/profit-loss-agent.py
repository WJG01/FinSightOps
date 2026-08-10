"""
P&L AI Agent — AWS Lambda Handler
==================================
Uses Strands Agents SDK (unchanged from original) to build an AI agent that
reads financial data from DynamoDB and generates Profit & Loss statements.

REWRITE NOTE (2026-08-10): the original tools filtered on "category" and a
flat "type" ("revenue"/"expense") field that never existed on real ledger
data — every transaction was silently skipped, so calculate_pnl always
returned net_income: 0 on real runs. Ledger's actual journal entries carry:
  - expense-style entries: debit_account, debit_account_name,
    debit_account_type, credit_account, credit_account_name,
    credit_account_type, amount, date
  - tabular-style entries: account_code, account_type, debit, credit, date
This rewrite aggregates debit/credit per account (same logic as ledger's own
build_trial_balance()) scoped to a date range, then classifies by the real
account_type. This also fixes gross_profit, which was previously identical
to net_income (COGS and Expense were never distinguished) — now Gross
Profit = Revenue − COGS, and Net Income = Gross Profit − Operating Expenses.

PERSISTENCE (2026-08-10): calculate_pnl now writes its result back to
DynamoDB as a structured item (PK="pnl#{start}_{end}", SK="statement"),
not just a natural-language string handed to Strands. Balance Sheet needs
a real numeric net_income to build the equity section — it can't reliably
parse that out of markdown text. Query it directly:
  table.get_item(Key={"PK": f"pnl#{start_date}_{end_date}", "SK": "statement"})

Strands Lambda Layer ARN (v2 = SDK v1.40.0):
  arn:aws:lambda:{region}:856699698935:layer:strands-agents-py3_12-aarch64:2
  (for x86_64, use: strands-agents-py3_12-x86_64:2)

Environment Variables:
  TABLE_NAME  — DynamoDB table name (default: auditai-ledger)

IAM Permissions needed:
  - dynamodb:Scan, dynamodb:PutItem on the table   (PutItem is new — for persistence)
  - bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream
"""

import json
import os
import logging
import calendar
from datetime import datetime, timezone
from decimal import Decimal
from collections import defaultdict

import boto3
from boto3.dynamodb.conditions import Attr
from strands import Agent, tool

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ.get("TABLE_NAME", "auditai-ledger")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)


def decimals_to_floats(obj):
    """Recursively convert Decimal values to float for JSON serialization."""
    if isinstance(obj, list):
        return [decimals_to_floats(i) for i in obj]
    elif isinstance(obj, dict):
        return {k: decimals_to_floats(v) for k, v in obj.items()}
    elif isinstance(obj, Decimal):
        return float(obj)
    return obj


def _scan_all(filter_expression):
    """Scan with pagination handled — DynamoDB caps a single Scan response."""
    items = []
    resp = table.scan(FilterExpression=filter_expression)
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = table.scan(FilterExpression=filter_expression, ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))
    return decimals_to_floats(items)


def save_pnl_to_dynamo(start_date: str, end_date: str, result: dict) -> None:
    """
    Persist a structured P&L result so Balance Sheet (or anything else) can
    read net_income as a real number, not parse it out of markdown text.

    Keyed by period, not run_id — a P&L statement spans a date range across
    however many documents/runs fall inside it, not a single run.
    Overwrites any prior P&L computed for the exact same period (put_item,
    not conditional) — recomputing for the same range is expected as more
    documents get added.
    """
    def to_decimal_strs(d: dict) -> dict:
        return {k: (str(v) if isinstance(v, (int, float)) else v) for k, v in d.items()}

    table.put_item(Item={
        "PK":             f"pnl#{start_date}_{end_date}",
        "SK":             "statement",
        "item_type":      "pnl_statement",
        "period":         {"start": start_date, "end": end_date},
        "created_at":     datetime.now(timezone.utc).isoformat(),
        "revenue_items":  to_decimal_strs(result["revenue_items"]),
        "cogs_items":     to_decimal_strs(result["cogs_items"]),
        "expense_items":  to_decimal_strs(result["expense_items"]),
        "total_revenue":  str(result["total_revenue"]),
        "total_cogs":     str(result["total_cogs"]),
        "total_expenses": str(result["total_expenses"]),
        "gross_profit":   str(result["gross_profit"]),
        "net_income":     str(result["net_income"]),
        "transaction_count": result["transaction_count"],
    })
    logger.info(f"P&L statement saved for {start_date}..{end_date}: net_income={result['net_income']}")


# ===========================================================================
# TOOLS — These are the functions the AI agent can call
# ===========================================================================

@tool
def get_transactions_by_period(start_date: str, end_date: str) -> dict:
    """
    Retrieve all journal entries (not the aggregated trial_balance item)
    between two dates (inclusive).

    Args:
        start_date: Start date in YYYY-MM-DD format (e.g. "2026-01-01")
        end_date:   End date in YYYY-MM-DD format (e.g. "2026-03-31")

    Returns:
        dict with 'transactions' list and 'count'.
    """
    try:
        items = _scan_all(
            Attr("item_type").eq("journal_entry") & Attr("date").between(start_date, end_date)
        )
        return {"transactions": items, "count": len(items)}
    except Exception as e:
        return {"error": str(e)}


@tool
def get_transactions_by_account_type(account_type: str) -> dict:
    """
    Retrieve all journal entries touching a given account type.

    Args:
        account_type: One of "Revenue", "COGS", "Expense", "Asset",
                       "Liability", "Equity" — matches the chart of
                       accounts' type field exactly (case-sensitive).

    Returns:
        dict with 'transactions' list and 'count'.
    """
    try:
        items = _scan_all(
            Attr("item_type").eq("journal_entry") & (
                Attr("debit_account_type").eq(account_type)
                | Attr("credit_account_type").eq(account_type)
                | Attr("account_type").eq(account_type)
            )
        )
        return {"transactions": items, "count": len(items)}
    except Exception as e:
        return {"error": str(e)}


@tool
def list_all_account_types() -> dict:
    """
    List every distinct account type actually present in the ledger so far
    (e.g. ["Asset", "COGS", "Expense", "Liability", "Revenue"]).

    Returns:
        dict with 'account_types' list.
    """
    try:
        items = _scan_all(Attr("item_type").eq("journal_entry"))
        types = set()
        for it in items:
            for key in ("debit_account_type", "credit_account_type", "account_type"):
                if it.get(key):
                    types.add(it[key])
        return {"account_types": sorted(types)}
    except Exception as e:
        return {"error": str(e)}


def _aggregate_accounts(entries: list[dict]) -> dict:
    """
    Aggregate debit/credit totals per account code across a set of entries —
    the same logic ledger's own build_trial_balance() uses, just scoped to
    whatever date-filtered entries were passed in rather than a whole run.

    Handles both entry shapes:
      - expense-style: debit_account / credit_account / amount (two legs)
      - tabular-style: account_code / debit / credit (one leg per entry)
    """
    totals = defaultdict(lambda: {"debit": 0.0, "credit": 0.0, "name": "", "type": "Unknown"})

    for e in entries:
        if "debit_account" in e:
            code = e["debit_account"]
            totals[code]["debit"] += float(e.get("amount", 0))
            totals[code]["name"] = e.get("debit_account_name") or totals[code]["name"]
            totals[code]["type"] = e.get("debit_account_type") or totals[code]["type"]

            code2 = e["credit_account"]
            totals[code2]["credit"] += float(e.get("amount", 0))
            totals[code2]["name"] = e.get("credit_account_name") or totals[code2]["name"]
            totals[code2]["type"] = e.get("credit_account_type") or totals[code2]["type"]

        elif "account_code" in e:
            code = e["account_code"]
            totals[code]["debit"]  += float(e.get("debit", 0))
            totals[code]["credit"] += float(e.get("credit", 0))
            totals[code]["name"]   = e.get("description") or totals[code]["name"]
            totals[code]["type"]   = e.get("account_type") or totals[code]["type"]

    return totals


@tool
def calculate_pnl(start_date: str, end_date: str) -> dict:
    """
    Calculate a full Profit & Loss breakdown for a date range, correctly
    separating Cost of Sales (COGS) from operating Expenses so Gross Profit
    and Net Income are two different, meaningful numbers.

    Args:
        start_date: Start date in YYYY-MM-DD format
        end_date:   End date in YYYY-MM-DD format

    Returns:
        dict with revenue_items, cogs_items, expense_items, total_revenue,
        total_cogs, total_expenses, gross_profit, net_income, and period info.
    """
    try:
        result = get_transactions_by_period(start_date, end_date)
        if "error" in result:
            return result

        entries = result["transactions"]
        totals = _aggregate_accounts(entries)

        revenue_items, cogs_items, expense_items = {}, {}, {}

        for code, t in totals.items():
            label = t["name"] or code
            net_credit = round(t["credit"] - t["debit"], 2)   # revenue-normal
            net_debit  = round(t["debit"] - t["credit"], 2)   # expense/COGS-normal

            if t["type"] == "Revenue" and net_credit != 0:
                revenue_items[label] = net_credit
            elif t["type"] == "COGS" and net_debit != 0:
                cogs_items[label] = net_debit
            elif t["type"] == "Expense" and net_debit != 0:
                expense_items[label] = net_debit
            # Asset / Liability / Equity accounts touched in this range
            # belong on the Balance Sheet, not here — deliberately ignored.

        total_revenue  = round(sum(revenue_items.values()), 2)
        total_cogs     = round(sum(cogs_items.values()), 2)
        total_expenses = round(sum(expense_items.values()), 2)
        gross_profit   = round(total_revenue - total_cogs, 2)
        net_income     = round(gross_profit - total_expenses, 2)

        result = {
            "period": {"start": start_date, "end": end_date},
            "revenue_items": revenue_items,
            "cogs_items": cogs_items,
            "expense_items": expense_items,
            "total_revenue": total_revenue,
            "total_cogs": total_cogs,
            "total_expenses": total_expenses,
            "gross_profit": gross_profit,
            "net_income": net_income,
            "transaction_count": len(entries),
        }

        try:
            save_pnl_to_dynamo(start_date, end_date, result)
        except Exception as save_exc:
            # Don't fail the whole tool call if persistence fails — the
            # agent can still present the number, just log it clearly so
            # the gap doesn't go unnoticed.
            logger.error(f"Failed to persist P&L statement: {save_exc}")

        return result
    except Exception as e:
        return {"error": str(e)}


@tool
def get_monthly_summary(year: int) -> dict:
    """
    Get a month-by-month P&L summary for a given year.

    Args:
        year: The year (e.g. 2026)

    Returns:
        dict with monthly breakdown of revenue, cogs, expenses, gross
        profit, and net income.
    """
    try:
        summary = {}
        for month in range(1, 13):
            last_day = calendar.monthrange(year, month)[1]
            start = f"{year}-{month:02d}-01"
            end   = f"{year}-{month:02d}-{last_day:02d}"

            month_pnl = calculate_pnl(start, end)
            if "error" in month_pnl:
                return month_pnl
            if month_pnl["transaction_count"] == 0:
                continue   # skip months with no activity

            key = f"{year}-{month:02d}"
            summary[key] = {
                "total_revenue":  month_pnl["total_revenue"],
                "total_cogs":     month_pnl["total_cogs"],
                "total_expenses": month_pnl["total_expenses"],
                "gross_profit":   month_pnl["gross_profit"],
                "net_income":     month_pnl["net_income"],
            }

        return {"year": year, "monthly_summary": summary}
    except Exception as e:
        return {"error": str(e)}


# ===========================================================================
# AGENT SETUP
# ===========================================================================

SYSTEM_PROMPT = """You are a financial analyst AI agent. Your job is to generate
Profit & Loss (P&L) statements from company transaction data stored in DynamoDB.

When asked to create a P&L statement, you should:

1. First determine the date range the user wants (quarter, month, year, etc.)
2. Use the calculate_pnl tool to get the financial data
3. If the user wants a monthly breakdown, use get_monthly_summary
4. Present the data as a clean, well-formatted P&L statement

Standard P&L format:
  - Revenue section (list each revenue account and amount)
  - Total Revenue
  - Cost of Sales / COGS section (list each COGS account and amount)
  - Gross Profit (Total Revenue − Total COGS)
  - Operating Expenses section (list each expense account and amount)
  - Total Operating Expenses
  - Net Income (Gross Profit − Total Operating Expenses)

Gross Profit and Net Income are two DIFFERENT numbers — never present them
as the same figure. Gross Profit measures margin before overhead; Net
Income is what's left after everything.

Use currency formatting ($X,XXX.XX). Always show the period covered.
If data is missing or empty, say so clearly rather than guessing.

Date reference shortcuts:
  - Q1 = Jan 1 – Mar 31
  - Q2 = Apr 1 – Jun 30
  - Q3 = Jul 1 – Sep 30
  - Q4 = Oct 1 – Dec 31
  - "Last month" = the previous calendar month
  - "YTD" = Jan 1 to today
"""

TOOLS = [
    get_transactions_by_period,
    get_transactions_by_account_type,
    list_all_account_types,
    calculate_pnl,
    get_monthly_summary,
]


def create_agent():
    """Create and return the Strands agent."""
    return Agent(
        system_prompt=SYSTEM_PROMPT,
        tools=TOOLS,
        # Default model provider is Amazon Bedrock → Claude Sonnet
        # To change model, uncomment and edit:
        # model="us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    )


# ===========================================================================
# LAMBDA HANDLER
# ===========================================================================

def lambda_handler(event, context):
    """
    AWS Lambda entry point.

    Accepts:
      POST body: {"query": "Generate a P&L for Q1 2026"}
      Or direct invocation: {"query": "..."}
    """
    logger.info(f"Event received: {json.dumps(event)}")

    try:
        if "body" in event:
            body = json.loads(event["body"]) if isinstance(event["body"], str) else event["body"]
            query = body.get("query", "")
        else:
            query = event.get("query", "")

        if not query:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Missing 'query' in request body"}),
            }

        agent = create_agent()
        response = agent(query)

        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "query": query,
                "response": str(response),
            }),
        }

    except Exception as e:
        logger.error(f"Error: {str(e)}", exc_info=True)
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}),
        }
