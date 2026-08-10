"""
Financial AI Agent — AWS Lambda Handler
========================================
Uses Strands Agents SDK to build an AI agent that reads financial data
from DynamoDB and generates Profit & Loss statements AND Balance Sheets.

Two DynamoDB Tables:
  - financial_transactions  → P&L data (revenue & expense records)
  - balance_sheet_accounts  → Balance Sheet data (assets, liabilities, equity)

Strands Lambda Layer ARN:
  arn:aws:lambda:{region}:856699698935:layer:strands-agents-py312-arm64:{version}

Environment Variables:
  TRANSACTIONS_TABLE  — (default: financial_transactions)
  BALANCE_SHEET_TABLE — (default: balance_sheet_accounts)

IAM Permissions needed:
  - dynamodb:Scan, dynamodb:Query, dynamodb:GetItem on BOTH tables
  - bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream
"""

import json
import os
import logging
from datetime import datetime
from decimal import Decimal
from collections import defaultdict

import boto3
from boto3.dynamodb.conditions import Key, Attr
from strands import Agent, tool

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# TRANSACTIONS_TABLE = os.environ.get("TRANSACTIONS_TABLE", "financial_transactions")
# BALANCE_SHEET_TABLE = os.environ.get("BALANCE_SHEET_TABLE", "balance_sheet_accounts")

TABLE_NAME = os.environ.get("TABLE_NAME", "auditai-documents")
dynamodb = boto3.resource("dynamodb")

txn_table = dynamodb.Table(TABLE_NAME)
bs_table = dynamodb.Table(TABLE_NAME)


# ---------------------------------------------------------------------------
# Helper: convert Decimal (DynamoDB) → float (JSON-safe)
# ---------------------------------------------------------------------------
def decimals_to_floats(obj):
    """Recursively convert Decimal values to float for JSON serialization."""
    if isinstance(obj, list):
        return [decimals_to_floats(i) for i in obj]
    elif isinstance(obj, dict):
        return {k: decimals_to_floats(v) for k, v in obj.items()}
    elif isinstance(obj, Decimal):
        return float(obj)
    return obj


def _scan_all(table_ref, **kwargs):
    """Scan with automatic pagination."""
    items = []
    response = table_ref.scan(**kwargs)
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table_ref.scan(
            ExclusiveStartKey=response["LastEvaluatedKey"], **kwargs
        )
        items.extend(response.get("Items", []))
    return decimals_to_floats(items)


# ===========================================================================
# P&L TOOLS (Profit & Loss)
# ===========================================================================

@tool
def get_transactions_by_period(start_date: str, end_date: str) -> dict:
    """
    Retrieve all financial transactions between two dates (inclusive).

    Args:
        start_date: Start date in YYYY-MM-DD format (e.g. "2025-01-01")
        end_date:   End date in YYYY-MM-DD format (e.g. "2025-03-31")

    Returns:
        dict with 'transactions' list and 'count'.
    """
    try:
        items = _scan_all(
            txn_table,
            FilterExpression=Attr("date").between(start_date, end_date),
        )
        return {"transactions": items, "count": len(items)}
    except Exception as e:
        return {"error": str(e)}


@tool
def get_transactions_by_category(category: str) -> dict:
    """
    Retrieve all transactions for a specific category.

    Args:
        category: The category name (e.g. "Sales Revenue", "Rent", "Salaries")

    Returns:
        dict with 'transactions' list and 'count'.
    """
    try:
        items = _scan_all(txn_table, FilterExpression=Attr("category").eq(category))
        return {"transactions": items, "count": len(items)}
    except Exception as e:
        return {"error": str(e)}


@tool
def list_all_categories() -> dict:
    """
    List every unique category in the transactions table.

    Returns:
        dict with 'categories' list.
    """
    try:
        items = _scan_all(txn_table, ProjectionExpression="category")
        categories = sorted({item.get("category", "Uncategorized") for item in items})
        return {"categories": categories}
    except Exception as e:
        return {"error": str(e)}


@tool
def calculate_pnl(start_date: str, end_date: str) -> dict:
    """
    Calculate a full Profit & Loss breakdown for a date range.

    Args:
        start_date: Start date in YYYY-MM-DD format
        end_date:   End date in YYYY-MM-DD format

    Returns:
        dict with revenue_items, expense_items, total_revenue,
        total_expenses, net_income, and period info.
    """
    try:
        result = get_transactions_by_period(start_date=start_date, end_date=end_date)
        if "error" in result:
            return result

        revenue_items = defaultdict(float)
        expense_items = defaultdict(float)

        for txn in result["transactions"]:
            category = txn.get("category", "Uncategorized")
            amount = float(txn.get("amount", 0))
            txn_type = txn.get("type", "").lower()

            if txn_type == "revenue":
                revenue_items[category] += amount
            elif txn_type == "expense":
                expense_items[category] += amount

        total_revenue = sum(revenue_items.values())
        total_expenses = sum(expense_items.values())

        return {
            "period": {"start": start_date, "end": end_date},
            "revenue_items": dict(revenue_items),
            "expense_items": dict(expense_items),
            "total_revenue": round(total_revenue, 2),
            "total_expenses": round(total_expenses, 2),
            "gross_profit": round(total_revenue - total_expenses, 2),
            "net_income": round(total_revenue - total_expenses, 2),
            "transaction_count": result["count"],
        }
    except Exception as e:
        return {"error": str(e)}


@tool
def get_monthly_summary(year: int) -> dict:
    """
    Get a month-by-month revenue and expense summary for a given year.

    Args:
        year: The year (e.g. 2025)

    Returns:
        dict with monthly breakdown of revenue, expenses, and net income.
    """
    try:
        start = f"{year}-01-01"
        end = f"{year}-12-31"
        result = get_transactions_by_period(start_date=start, end_date=end)
        if "error" in result:
            return result

        monthly = defaultdict(lambda: {"revenue": 0.0, "expenses": 0.0})

        for txn in result["transactions"]:
            month = txn.get("date", "")[:7]
            amount = float(txn.get("amount", 0))
            txn_type = txn.get("type", "").lower()

            if txn_type == "revenue":
                monthly[month]["revenue"] += amount
            elif txn_type == "expense":
                monthly[month]["expenses"] += amount

        summary = {}
        for month in sorted(monthly.keys()):
            d = monthly[month]
            summary[month] = {
                "revenue": round(d["revenue"], 2),
                "expenses": round(d["expenses"], 2),
                "net_income": round(d["revenue"] - d["expenses"], 2),
            }

        return {"year": year, "monthly_summary": summary}
    except Exception as e:
        return {"error": str(e)}


# ===========================================================================
# BALANCE SHEET TOOLS
# ===========================================================================

@tool
def get_balance_sheet_accounts(as_of_date: str) -> dict:
    """
    Retrieve all balance sheet account balances as of a specific date.
    Returns the latest snapshot on or before the given date for each account.

    Args:
        as_of_date: Date in YYYY-MM-DD format (e.g. "2025-03-31")

    Returns:
        dict with 'accounts' list — each has account_id, account_name,
        account_type, sub_type, balance, and snapshot_date.
    """
    try:
        items = _scan_all(
            bs_table,
            FilterExpression=Attr("snapshot_date").lte(as_of_date),
        )

        # Keep only the latest snapshot per account
        latest = {}
        for item in items:
            acct_id = item["account_id"]
            if acct_id not in latest or item["snapshot_date"] > latest[acct_id]["snapshot_date"]:
                latest[acct_id] = item

        return {"accounts": list(latest.values()), "as_of_date": as_of_date}
    except Exception as e:
        return {"error": str(e)}


@tool
def get_accounts_by_type(account_type: str, as_of_date: str) -> dict:
    """
    Retrieve balance sheet accounts filtered by type.

    Args:
        account_type: One of "asset", "liability", or "equity"
        as_of_date:   Date in YYYY-MM-DD format

    Returns:
        dict with filtered accounts and their balances.
    """
    try:
        items = _scan_all(
            bs_table,
            FilterExpression=(
                Attr("account_type").eq(account_type.lower())
                & Attr("snapshot_date").lte(as_of_date)
            ),
        )

        latest = {}
        for item in items:
            acct_id = item["account_id"]
            if acct_id not in latest or item["snapshot_date"] > latest[acct_id]["snapshot_date"]:
                latest[acct_id] = item

        return {
            "account_type": account_type,
            "accounts": list(latest.values()),
            "as_of_date": as_of_date,
        }
    except Exception as e:
        return {"error": str(e)}


@tool
def calculate_balance_sheet(as_of_date: str) -> dict:
    """
    Calculate a full Balance Sheet as of a specific date.
    Applies the accounting equation: Assets = Liabilities + Equity.

    Args:
        as_of_date: Date in YYYY-MM-DD format (e.g. "2025-06-30")

    Returns:
        dict with current_assets, non_current_assets, current_liabilities,
        non_current_liabilities, equity_items, totals, and whether it balances.
    """
    try:
        result = get_balance_sheet_accounts(as_of_date=as_of_date)
        if "error" in result:
            return result

        accounts = result["accounts"]

        current_assets = {}
        non_current_assets = {}
        current_liabilities = {}
        non_current_liabilities = {}
        equity_items = {}

        for acct in accounts:
            name = acct.get("account_name", "Unknown")
            balance = float(acct.get("balance", 0))
            acct_type = acct.get("account_type", "").lower()
            sub_type = acct.get("sub_type", "").lower()

            if acct_type == "asset":
                if sub_type == "current":
                    current_assets[name] = balance
                else:
                    non_current_assets[name] = balance

            elif acct_type == "liability":
                if sub_type == "current":
                    current_liabilities[name] = balance
                else:
                    non_current_liabilities[name] = balance

            elif acct_type == "equity":
                equity_items[name] = balance

        total_current_assets = sum(current_assets.values())
        total_non_current_assets = sum(non_current_assets.values())
        total_assets = total_current_assets + total_non_current_assets

        total_current_liabilities = sum(current_liabilities.values())
        total_non_current_liabilities = sum(non_current_liabilities.values())
        total_liabilities = total_current_liabilities + total_non_current_liabilities

        total_equity = sum(equity_items.values())

        is_balanced = abs(total_assets - (total_liabilities + total_equity)) < 0.01

        return {
            "as_of_date": as_of_date,
            "current_assets": current_assets,
            "total_current_assets": round(total_current_assets, 2),
            "non_current_assets": non_current_assets,
            "total_non_current_assets": round(total_non_current_assets, 2),
            "total_assets": round(total_assets, 2),
            "current_liabilities": current_liabilities,
            "total_current_liabilities": round(total_current_liabilities, 2),
            "non_current_liabilities": non_current_liabilities,
            "total_non_current_liabilities": round(total_non_current_liabilities, 2),
            "total_liabilities": round(total_liabilities, 2),
            "equity": equity_items,
            "total_equity": round(total_equity, 2),
            "total_liabilities_and_equity": round(total_liabilities + total_equity, 2),
            "is_balanced": is_balanced,
            "account_count": len(accounts),
        }
    except Exception as e:
        return {"error": str(e)}


@tool
def compare_balance_sheets(date_1: str, date_2: str) -> dict:
    """
    Compare balance sheets between two dates to show changes over time.

    Args:
        date_1: Earlier date in YYYY-MM-DD format (e.g. "2025-03-31")
        date_2: Later date in YYYY-MM-DD format (e.g. "2025-06-30")

    Returns:
        dict with both balance sheets and the changes between them.
    """
    try:
        bs1 = calculate_balance_sheet(as_of_date=date_1)
        bs2 = calculate_balance_sheet(as_of_date=date_2)

        if "error" in bs1:
            return bs1
        if "error" in bs2:
            return bs2

        changes = {
            "total_assets_change": round(bs2["total_assets"] - bs1["total_assets"], 2),
            "total_liabilities_change": round(bs2["total_liabilities"] - bs1["total_liabilities"], 2),
            "total_equity_change": round(bs2["total_equity"] - bs1["total_equity"], 2),
            "current_assets_change": round(bs2["total_current_assets"] - bs1["total_current_assets"], 2),
            "non_current_assets_change": round(bs2["total_non_current_assets"] - bs1["total_non_current_assets"], 2),
        }

        return {
            "period_1": bs1,
            "period_2": bs2,
            "changes": changes,
        }
    except Exception as e:
        return {"error": str(e)}


@tool
def list_balance_sheet_account_names() -> dict:
    """
    List all unique account names and types in the balance sheet table.

    Returns:
        dict with 'accounts' list of {account_name, account_type, sub_type}.
    """
    try:
        items = _scan_all(
            bs_table,
            ProjectionExpression="account_name, account_type, sub_type",
        )
        seen = {}
        for item in items:
            name = item.get("account_name", "Unknown")
            if name not in seen:
                seen[name] = {
                    "account_name": name,
                    "account_type": item.get("account_type", ""),
                    "sub_type": item.get("sub_type", ""),
                }
        return {"accounts": sorted(seen.values(), key=lambda x: (x["account_type"], x["account_name"]))}
    except Exception as e:
        return {"error": str(e)}


# ===========================================================================
# AGENT SETUP
# ===========================================================================

SYSTEM_PROMPT = """You are a financial analyst AI agent. You generate two types
of financial statements from company data stored in DynamoDB:

  1. PROFIT & LOSS (P&L) STATEMENT — from the transactions table
  2. BALANCE SHEET — from the balance sheet accounts table

═══════════════════════════════════════════════════════
PROFIT & LOSS STATEMENT
═══════════════════════════════════════════════════════

When asked for a P&L / income statement:
1. Determine the date range (quarter, month, year, etc.)
2. Use calculate_pnl to get the data
3. Use get_monthly_summary for month-by-month breakdowns
4. Present in this format:

   PROFIT & LOSS STATEMENT
   Period: [start] to [end]

   REVENUE
     Sales Revenue ............. $XX,XXX.XX
     Service Revenue ........... $XX,XXX.XX
     (other categories)
   ─────────────────────────────────────────
   TOTAL REVENUE                 $XX,XXX.XX

   EXPENSES
     Salaries .................. $XX,XXX.XX
     Rent ...................... $XX,XXX.XX
     (other categories)
   ─────────────────────────────────────────
   TOTAL EXPENSES                $XX,XXX.XX

   ═════════════════════════════════════════
   GROSS PROFIT                  $XX,XXX.XX
   NET INCOME                    $XX,XXX.XX

═══════════════════════════════════════════════════════
BALANCE SHEET
═══════════════════════════════════════════════════════

When asked for a balance sheet:
1. Determine the "as of" date (end of quarter, end of month, etc.)
2. Use calculate_balance_sheet to get the data
3. Use compare_balance_sheets if the user wants to see changes over time
4. Present in this format:

   BALANCE SHEET
   As of: [date]

   ASSETS
   Current Assets
     Cash & Equivalents ........ $XX,XXX.XX
     Accounts Receivable ........ $XX,XXX.XX
     Inventory .................. $XX,XXX.XX
   ─────────────────────────────────────────
   Total Current Assets          $XX,XXX.XX

   Non-Current Assets
     Property & Equipment ....... $XX,XXX.XX
     (other items)
   ─────────────────────────────────────────
   Total Non-Current Assets      $XX,XXX.XX

   ═════════════════════════════════════════
   TOTAL ASSETS                  $XX,XXX.XX

   LIABILITIES
   Current Liabilities
     Accounts Payable ........... $XX,XXX.XX
     (other items)
   ─────────────────────────────────────────
   Total Current Liabilities     $XX,XXX.XX

   Non-Current Liabilities
     Long-Term Debt ............. $XX,XXX.XX
   ─────────────────────────────────────────
   Total Non-Current Liabilities $XX,XXX.XX

   ═════════════════════════════════════════
   TOTAL LIABILITIES             $XX,XXX.XX

   EQUITY
     Owner's Equity ............. $XX,XXX.XX
     Retained Earnings .......... $XX,XXX.XX
   ─────────────────────────────────────────
   TOTAL EQUITY                  $XX,XXX.XX

   ═════════════════════════════════════════
   TOTAL LIABILITIES + EQUITY    $XX,XXX.XX

   ✓ Balance Sheet is balanced (Assets = Liabilities + Equity)

═══════════════════════════════════════════════════════
GENERAL RULES
═══════════════════════════════════════════════════════

- Use currency formatting ($X,XXX.XX) everywhere.
- Always show the period or date covered.
- If data is missing or empty, say so clearly — never guess.
- If asked for "financial statements" or "financials", generate BOTH the P&L
  AND the Balance Sheet together.
- You can generate a combined report if the user asks.

Date shortcuts:
  Q1 = Jan 1 – Mar 31    Q2 = Apr 1 – Jun 30
  Q3 = Jul 1 – Sep 30    Q4 = Oct 1 – Dec 31
  "Last month" = previous calendar month
  "YTD" = Jan 1 to today
  "End of Q1" = March 31, "End of Q2" = June 30, etc.
"""

# All tools the agent can use
TOOLS = [
    # P&L tools
    get_transactions_by_period,
    get_transactions_by_category,
    list_all_categories,
    calculate_pnl,
    get_monthly_summary,
    # Balance Sheet tools
    get_balance_sheet_accounts,
    get_accounts_by_type,
    calculate_balance_sheet,
    compare_balance_sheets,
    list_balance_sheet_account_names,
]


def create_agent():
    """Create and return the Strands agent."""
    return Agent(
        system_prompt=SYSTEM_PROMPT,
        tools=TOOLS,
    )


# ===========================================================================
# LAMBDA HANDLER
# ===========================================================================

def lambda_handler(event, context):
    """
    AWS Lambda entry point.

    Accepts:
      POST body: {"query": "Generate a balance sheet as of Q2 2025"}
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
