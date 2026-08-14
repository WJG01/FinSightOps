"""
balance_sheet_agent/lambda_function.py
Balance Sheet Agent — Assets = Liabilities + Equity, for one run's worth
of journal entries.

Region  : ap-southeast-1
Money   : Decimal everywhere, never float (matches ledger's discipline).
No Bedrock call — no genuine judgment call in this agent's core job.

REVISION (2026-08-10): rewritten from period-keyed to run-keyed, to match
reconciliation's design — one trial_balance + one pnl + one balance_sheet
per run_id, all under PK=f"run#{run_id}". Matches ledger's own per-run
trial_balance precedent, and lets Query replace Scan (cheaper, simpler).

KNOWN SIMPLIFICATION (unchanged from the period-keyed version): a real
balance sheet is a lifetime-cumulative snapshot, not scoped to one run.
This system has no "close the books" / rollforward mechanism yet — there's
no carried-forward prior balance. This agent's Assets/Liabilities/Equity
reflect only the entries posted under this one run_id. Revisit once a
rollforward/closing mechanism exists.

Dependency: P&L must have already been run for the SAME run_id — this
agent reads table.get_item(PK=f"run#{run_id}", SK="pnl") and returns a
clear error if it's missing, rather than silently treating net_income as 0.

Output contract (returned + written to DynamoDB, only if balanced):
{
  "status": "balanced",
  "run_id": "...",
  "balance_sheet": {
    "assets": {"Accounts Receivable": "5150.00", ...},
    "liabilities": {"Accounts Payable": "309.00", ...},
    "equity": {"Current Period Net Income": "10600.00", ...},
    "total_assets": "...", "total_liabilities": "...", "total_equity": "...",
    "is_balanced": true, "imbalance": "0.00"
  }
}

Env vars required:
  DYNAMO_TABLE   default "auditai-ledger"

IAM Permissions needed:
  - dynamodb:Query, dynamodb:GetItem, dynamodb:PutItem on auditai-ledger
"""

import json
import os
import logging
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from collections import defaultdict

import boto3
from boto3.dynamodb.conditions import Key
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


# ── Fetch P&L's persisted net income, for this same run ────────────────────

def fetch_net_income(run_id: str) -> Decimal:
    """
    Raises RuntimeError if P&L hasn't been run for this run_id yet —
    deliberately loud, since silently treating a missing net_income as 0
    would misrepresent equity.
    """
    resp = _table.get_item(Key={"PK": f"run#{run_id}", "SK": "pnl"})
    item = resp.get("Item")
    if not item:
        raise RuntimeError(
            f"No P&L found for run_id={run_id!r}. "
            "Run P&L for this run first — Balance Sheet needs its net_income."
        )
    return d(item["net_income"])


# ── Fetch and aggregate journal entries for this run ────────────────────────

def fetch_entries(run_id: str) -> list[dict]:
    """Query, scoped to this run's own entries — same partition ledger
    itself wrote them under."""
    items = []
    key_expr = Key("PK").eq(f"run#{run_id}") & Key("SK").begins_with("entry#")
    resp = _table.query(KeyConditionExpression=key_expr)
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = _table.query(KeyConditionExpression=key_expr, ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))
    return items


def aggregate_accounts(entries: list[dict]) -> dict:
    """
    Same aggregation logic as ledger's build_trial_balance() — debit/credit
    totals per account code, across both entry shapes.
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
    Revenue/COGS/Expense accounts are deliberately excluded — their net
    effect already flows into equity via net_income (its own line, not
    silently merged into Retained Earnings, so it's visible where it came from).
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

    equity["Current Period Net Income"] = ds(net_income)

    # Reconciliation reads bs["cash"] directly (account 1000, Cash) — not
    # just whatever key happens to land in the generic assets dict. Compute
    # it explicitly so cash_agrees_with_ledger and bank reconciliation have
    # something real to read, even if Cash never moved this run (defaults
    # to 0.00, matching what the trial balance would show too).
    cash_totals = totals.get("1000", {"debit": Decimal("0"), "credit": Decimal("0")})
    cash_balance = (cash_totals["debit"] - cash_totals["credit"]).quantize(TWO_PLACES)

    total_assets      = sum((Decimal(v) for v in assets.values()), Decimal("0")).quantize(TWO_PLACES)
    total_liabilities = sum((Decimal(v) for v in liabilities.values()), Decimal("0")).quantize(TWO_PLACES)
    total_equity       = sum((Decimal(v) for v in equity.values()), Decimal("0")).quantize(TWO_PLACES)

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
        "cash":              ds(cash_balance),
        "total_assets":      ds(total_assets),
        "total_liabilities": ds(total_liabilities),
        "total_equity":      ds(total_equity),
        "is_balanced":       is_balanced,
        "imbalance":         ds(imbalance),
    }


# ── Persist ──────────────────────────────────────────────────────────────

def save_to_dynamo(run_id: str, balance_sheet: dict) -> None:
    """PK=run#{run_id}, SK=balance_sheet — the exact shape reconciliation's
    _get(run_id, "balance_sheet") expects."""
    _table.put_item(Item={
        "PK":         f"run#{run_id}",
        "SK":         "balance_sheet",
        "item_type":  "balance_sheet",
        "run_id":     run_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        **balance_sheet,
    })
    logger.info(f"Balance sheet saved for run_id={run_id}. balanced={balance_sheet['is_balanced']}")


# ── Handler ─────────────────────────────────────────────────────────────────

def lambda_handler(event: dict, context) -> dict:
    """
    event = {"run_id": "run-007"}

    REFUSES to write if Assets != Liabilities + Equity — same discipline
    as ledger refusing to write an unbalanced trial balance.
    """
    run_id = event.get("run_id")
    if not run_id:
        return {"status": "error", "message": "run_id is required"}

    logger.info(f"Balance sheet requested for run_id={run_id}")

    try:
        net_income = fetch_net_income(run_id)
    except RuntimeError as exc:
        return {"status": "missing_pnl", "message": str(exc)}

    entries = fetch_entries(run_id)
    if not entries:
        return {"status": "error", "message": f"No journal entries found for run_id={run_id!r}"}

    totals = aggregate_accounts(entries)
    balance_sheet = build_balance_sheet(totals, net_income)

    if not balance_sheet["is_balanced"]:
        return {
            "status": "unbalanced",
            "run_id": run_id,
            "balance_sheet": balance_sheet,
            "message": (
                f"Assets ({balance_sheet['total_assets']}) != "
                f"Liabilities + Equity ({ds(Decimal(balance_sheet['total_liabilities']) + Decimal(balance_sheet['total_equity']))}). "
                "Nothing written to DynamoDB."
            ),
        }

    try:
        save_to_dynamo(run_id, balance_sheet)
    except ClientError as exc:
        return {"status": "dynamo_error", "message": str(exc)}

    return {
        "status": "balanced",
        "run_id": run_id,
        "balance_sheet": balance_sheet,
    }