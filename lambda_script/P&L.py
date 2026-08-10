"""
P&L AI Agent — AWS Lambda Handler
==================================
Uses Strands Agents SDK to build an AI agent that reads financial data
from DynamoDB and generates Profit & Loss statements.

Strands Lambda Layer ARN (v2 = SDK v1.40.0):
  arn:aws:lambda:{region}:856699698935:layer:strands-agents-py3_12-aarch64:2
  (for x86_64, use: strands-agents-py3_12-x86_64:2)

Environment Variables:
  TABLE_NAME  — DynamoDB table name (default: auditai-documents)

IAM Permissions needed:
  - dynamodb:Scan, dynamodb:Query, dynamodb:GetItem on the table
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

TABLE_NAME = os.environ.get("TABLE_NAME", "auditai-ledger")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)


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


# ===========================================================================
# TOOLS — These are the functions the AI agent can call
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
        response = table.scan(
            FilterExpression=Attr("date").between(start_date, end_date)
        )
        items = decimals_to_floats(response.get("Items", []))

        # Handle pagination for large datasets
        while "LastEvaluatedKey" in response:
            response = table.scan(
                FilterExpression=Attr("date").between(start_date, end_date),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(decimals_to_floats(response.get("Items", [])))

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
        response = table.scan(
            FilterExpression=Attr("category").eq(category)
        )
        items = decimals_to_floats(response.get("Items", []))
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
        response = table.scan(ProjectionExpression="category")
        categories = set()
        for item in response.get("Items", []):
            categories.add(item.get("category", "Uncategorized"))

        while "LastEvaluatedKey" in response:
            response = table.scan(
                ProjectionExpression="category",
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            for item in response.get("Items", []):
                categories.add(item.get("category", "Uncategorized"))

        return {"categories": sorted(categories)}
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

        transactions = result["transactions"]

        revenue_items = defaultdict(float)
        expense_items = defaultdict(float)

        for txn in transactions:
            category = txn.get("category", "Uncategorized")
            amount = float(txn.get("amount", 0))
            txn_type = txn.get("type", "").lower()

            if txn_type == "revenue":
                revenue_items[category] += amount
            elif txn_type == "expense":
                expense_items[category] += amount

        total_revenue = sum(revenue_items.values())
        total_expenses = sum(expense_items.values())
        net_income = total_revenue - total_expenses

        return {
            "period": {"start": start_date, "end": end_date},
            "revenue_items": dict(revenue_items),
            "expense_items": dict(expense_items),
            "total_revenue": round(total_revenue, 2),
            "total_expenses": round(total_expenses, 2),
            "gross_profit": round(total_revenue - total_expenses, 2),
            "net_income": round(net_income, 2),
            "transaction_count": len(transactions),
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
            date_str = txn.get("date", "")
            month = date_str[:7]  # "YYYY-MM"
            amount = float(txn.get("amount", 0))
            txn_type = txn.get("type", "").lower()

            if txn_type == "revenue":
                monthly[month]["revenue"] += amount
            elif txn_type == "expense":
                monthly[month]["expenses"] += amount

        summary = {}
        for month in sorted(monthly.keys()):
            data = monthly[month]
            summary[month] = {
                "revenue": round(data["revenue"], 2),
                "expenses": round(data["expenses"], 2),
                "net_income": round(data["revenue"] - data["expenses"], 2),
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
  - Revenue section (list each revenue category and amount)
  - Total Revenue
  - Expenses section (list each expense category and amount)
  - Total Expenses
  - Gross Profit (Revenue - Expenses)
  - Net Income

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

# Tools the agent can use
TOOLS = [
    get_transactions_by_period,
    get_transactions_by_category,
    list_all_categories,
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
      POST body: {"query": "Generate a P&L for Q1 2025"}
      Or direct invocation: {"query": "..."}
    """
    logger.info(f"Event received: {json.dumps(event)}")

    try:
        # Parse the query from the event
        if "body" in event:
            # API Gateway / Function URL
            body = json.loads(event["body"]) if isinstance(event["body"], str) else event["body"]
            query = body.get("query", "")
        else:
            # Direct Lambda invocation
            query = event.get("query", "")

        if not query:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Missing 'query' in request body"}),
            }

        # Create agent and run
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
