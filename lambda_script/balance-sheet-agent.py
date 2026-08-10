"""
balance_sheet_agent/lambda_function.py
Balance Sheet Agent — Assets = Liabilities + Equity, as of the end of a
given period.

Region  : ap-southeast-1
Money   : Decimal everywhere, never float (matches ledger's discipline —
          this is the one other agent besides ledger with a real
          arithmetic invariant to protect).
No Bedrock call — there's no genuine judgment call in this agent's core
job. Deterministic math only, same principle as ledger's trial balance
builder.

KNOWN SIMPLIFICATION — read before changing the date logic:
A real balance sheet is a lifetime-cumulative snapshot (every Asset/
Liability/Equity balance since the company began), not scoped to one
period. This system has no "close the books" / rollforward mechanism yet,
so there's no such thing as a carried-forward prior balance. This agent
uses the SAME period window P&L was computed for (period_start..period_end)
and pulls that exact P&L's net_income. Revisit once a rollforward/closing
mechanism exists.

Dependency: P&L must have already been run for the EXACT SAME period —
this agent looks up table.get_item(PK=f"pnl#{start}_{end}") and returns a
clear error if it's missing, rather than silently treating net_income as 0.

Output contract (returned + written to DynamoDB, only if balanced):
{
  "status": "balanced",
  "period": {"start": "...", "end": "..."},
  "balance_sheet": {
    "assets": {"Cash": "5150.00", ...},
    "liabilities": {"Accounts Payable": "309.00", ...},
    "equity": {"Share Capital": "0.00", "Current Period Net Income": "10600.00", ...},
    "total_assets": "...", "total_liabilities": "...", "total_equity": "...",
    "is_balanced": true, "imbalance": "0.00"
  }
}

Env vars required:
  DYNAMO_TABLE   default "auditai-ledger"

IAM Permissions needed:
  - dynamodb:Scan, dynamodb:GetItem, dynamodb:PutItem on auditai-ledger
"""

import json
import os
import logging
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from collections import defaultdict

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION       = "ap-southeast-1"
DYNAMO_TABLE = os.environ.get("DYNAMO_TABLE", "auditai-ledger")
TWO_PLACES   = Decimal("0.01")

_dynamo = boto3.resource("dynamodb", region_name=REGION)
_table  = _dynamo.Table(DYNAMO_TABLE)


# ── Decimal helpers (same convention as ledger) ────────────────────────────

def d(value) -> Decimal:
    try:
        return Decimal(str(value)).quantize(TWO_PLACES, rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError) as exc:
        raise ValueError(f"Cannot convert {value!r} to Decimal: {exc}") from exc


def ds(value: Decimal) -> str:
    return str(value.quantize(TWO_PLACES))


# ── Fetch P&L's persisted net income ───────────────────────────────────────

def fetch_net_income(period_start: str, period_end: str) -> Decimal:
    """
    Raises RuntimeError if P&L hasn't been run for this exact period yet —
    deliberately loud, since silently treating a missing net_income as 0
    would misrepresent equity.
    """
    resp = _table.get_item(Key={"PK": f"pnl#{period_start}_{period_end}", "SK": "statement"})
    item = resp.get("Item")
    if not item:
        raise RuntimeError(
            f"No P&L statement found for period {period_start}..{period_end}. "
            "Run P&L for this exact period first — Balance Sheet needs its net_income."
        )
    return d(item["net_income"])


# ── Fetch and aggregate journal entries for the period ─────────────────────

def fetch_entries(period_start: str, period_end: str) -> list[dict]:
    items = []
    filter_expr = Attr("item_type").eq("journal_entry") & Attr("date").between(period_start, period_end)
    resp = _table.scan(FilterExpression=filter_expr)
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = _table.scan(FilterExpression=filter_expr, ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))
    return items


def aggregate_accounts(entries: list[dict]) -> dict:
    """
    Same aggregation logic as ledger's build_trial_balance() — debit/credit
    totals per account code, across both entry shapes (expense-style two-leg
    entries, tabular-style single-leg entries).
    """
    totals = defaultdict(lambda: {"debit": Decimal("0"), "credit": Decimal("0"), "name": "", "type": "Unknown"})

    for e in entries:
        if "debit_account" in e:
            code = e["debit_account"]
            totals[code]["debit"] += d(e.get("amount", 0))
            totals[code]["name"] = e.get("debit_account_name") or totals[code]["name"]
            totals[code]["type"] = e.get("debit_account_type") or totals[code]["type"]

            code2 = e["credit_account"]
            totals[code2]["credit"] += d(e.get("amount", 0))
            totals[code2]["name"] = e.get("credit_account_name") or totals[code2]["name"]
            totals[code2]["type"] = e.get("credit_account_type") or totals[code2]["type"]

        elif "account_code" in e:
            code = e["account_code"]
            totals[code]["debit"]  += d(e.get("debit", 0))
            totals[code]["credit"] += d(e.get("credit", 0))
            totals[code]["name"]   = e.get("description") or totals[code]["name"]
            totals[code]["type"]   = e.get("account_type") or totals[code]["type"]

    return totals


# ── Build the balance sheet ─────────────────────────────────────────────────

def build_balance_sheet(totals: dict, net_income: Decimal) -> dict:
    """
    Assets: normal debit balance -> net = debit - credit
    Liabilities & Equity: normal credit balance -> net = credit - debit
    Revenue/COGS/Expense accounts are deliberately excluded here — their
    net effect already flows into equity via net_income (added as its own
    line, not silently merged into Retained Earnings, so it's visible
    exactly where it came from).
    """
    assets, liabilities, equity = {}, {}, {}

    for code, t in totals.items():
        label = t["name"] or code
        net_debit  = (t["debit"] - t["credit"]).quantize(TWO_PLACES)
        net_credit = (t["credit"] - t["debit"]).quantize(TWO_PLACES)

        if t["type"] == "Asset" and net_debit != 0:
            assets[label] = ds(net_debit)
        elif t["type"] == "Liability" and net_credit != 0:
            liabilities[label] = ds(net_credit)
        elif t["type"] == "Equity" and net_credit != 0:
            equity[label] = ds(net_credit)
        # Revenue / COGS / Expense: belongs on the P&L, not here.

    equity["Current Period Net Income"] = ds(net_income)

    total_assets      = sum(Decimal(v) for v in assets.values())
    total_liabilities = sum(Decimal(v) for v in liabilities.values())
    total_equity       = sum(Decimal(v) for v in equity.values())

    total_assets      = total_assets.quantize(TWO_PLACES)
    total_liabilities = total_liabilities.quantize(TWO_PLACES)
    total_equity       = total_equity.quantize(TWO_PLACES)

    is_balanced = (total_assets == total_liabilities + total_equity)
    imbalance   = abs(total_assets - (total_liabilities + total_equity)).quantize(TWO_PLACES)

    if not is_balanced:
        logger.error(
            f"UNBALANCED — Assets={ds(total_assets)} "
            f"Liab+Equity={ds(total_liabilities + total_equity)} diff={ds(imbalance)}"
        )

    return {
        "assets":            assets,
        "liabilities":       liabilities,
        "equity":            equity,
        "total_assets":      ds(total_assets),
        "total_liabilities": ds(total_liabilities),
        "total_equity":      ds(total_equity),
        "is_balanced":       is_balanced,
        "imbalance":         ds(imbalance),
    }


# ── Persist ──────────────────────────────────────────────────────────────

def save_to_dynamo(period_start: str, period_end: str, balance_sheet: dict) -> None:
    _table.put_item(Item={
        "PK":         f"balance_sheet#{period_start}_{period_end}",
        "SK":         "statement",
        "item_type":  "balance_sheet",
        "period":     {"start": period_start, "end": period_end},
        "created_at": datetime.now(timezone.utc).isoformat(),
        **balance_sheet,
    })
    logger.info(f"Balance sheet saved for {period_start}..{period_end}. balanced={balance_sheet['is_balanced']}")


# ── Handler ─────────────────────────────────────────────────────────────────

def lambda_handler(event: dict, context) -> dict:
    """
    event = {"period_start": "2026-08-01", "period_end": "2026-08-31"}

    REFUSES to write if Assets != Liabilities + Equity — same discipline
    as ledger refusing to write an unbalanced trial balance. Downstream
    agents (Reconciliation) must never receive a broken balance sheet.
    """
    period_start = event.get("period_start")
    period_end   = event.get("period_end")

    if not period_start or not period_end:
        return {"status": "error", "message": "period_start and period_end are both required"}

    logger.info(f"Balance sheet requested for {period_start}..{period_end}")

    try:
        net_income = fetch_net_income(period_start, period_end)
    except RuntimeError as exc:
        return {"status": "missing_pnl", "message": str(exc)}

    entries = fetch_entries(period_start, period_end)
    if not entries:
        return {
            "status": "error",
            "message": f"No journal entries found for {period_start}..{period_end}",
        }

    totals = aggregate_accounts(entries)
    balance_sheet = build_balance_sheet(totals, net_income)

    if not balance_sheet["is_balanced"]:
        return {
            "status": "unbalanced",
            "period": {"start": period_start, "end": period_end},
            "balance_sheet": balance_sheet,
            "message": (
                f"Assets ({balance_sheet['total_assets']}) != "
                f"Liabilities + Equity ({ds(Decimal(balance_sheet['total_liabilities']) + Decimal(balance_sheet['total_equity']))}). "
                "Nothing written to DynamoDB."
            ),
        }

    try:
        save_to_dynamo(period_start, period_end, balance_sheet)
    except ClientError as exc:
        return {"status": "dynamo_error", "message": str(exc)}

    return {
        "status": "balanced",
        "period": {"start": period_start, "end": period_end},
        "balance_sheet": balance_sheet,
    }
