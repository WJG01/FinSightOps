"""
FinSightOps — Reconciliation + Tie-out Lambda
===============================================

API Gateway (proxy) -> Lambda -> DynamoDB

Request
-------
POST /reconciliation
    { "run_id": "2026-Q1" }

Optional filters in the same body:
    {
      "run_id":       "2026-Q1",
      "sections":     ["bank", "statements"],   # "bank" | "statements" | "gaps"
      "search":       "payroll",                # case-insensitive match on item label/desc
      "min_amount":   500,                      # drop gap lines smaller than this (abs)
      "status_filter": "fail",                  # "pass" | "fail" | "review" — show only this status
      "hide_matched": false                     # true = drop perfectly matched lines
    }

Reads the run partition written by the pipeline:

    PK = "run#<run_id>"
    SK = "reconciliation" | "reconciliation_output" | "pipeline" | ...

Expected source shape (from the Reconciliation + Tie-out agent):
    "reconciliation_output": {
      "status":   "success",
      "as_of_date": "2026-03-31",
      "period":   {"start": "2026-01-01", "end": "2026-03-31"},

      # ── Bank reconciliation ──
      "bank_reconciliation": {
        "book_cash_balance":         233915.10,
        "bank_statement_balance":    236255.10,
        "outstanding_checks":        [
          {"description": "Cheque #1042", "amount": 2340.00, "date": "2026-03-29"}
        ],
        "deposits_in_transit":       [],
        "bank_errors":               [],
        "book_errors":               [],
        "adjusted_book_balance":     236255.10,
        "adjusted_bank_balance":     236255.10,
        "reconciled":                true,
        "unreconciled_difference":   0.00
      },

      # ── Statement tie-out ──
      "statement_tieout": {
        "pnl_net_income":                28915.10,
        "balance_sheet_net_income":      28915.10,
        "net_income_match":              true,
        "total_assets":                  220000.00,
        "total_liabilities_and_equity":  220000.00,
        "accounting_equation_balanced":  true,
        "trial_balance_debits":          819000.00,
        "trial_balance_credits":         819000.00,
        "trial_balance_balanced":        true,
        "issues": []
      },

      # ── Gaps / unresolved items ──
      "gaps": [
        {
          "id":          "GAP-001",
          "description": "Uncleared cheque",
          "amount":      2340.00,
          "category":    "outstanding_check",
          "status":      "review",
          "note":        "Expected to clear within 5 business days."
        }
      ],

      "summary": {
        "total_gaps":          1,
        "total_gap_amount":    2340.00,
        "reconciled":          true,
        "statements_tied_out": true
      },

      "transaction_count": 42
    }

Response (200):
    {
      "run_id":        "...",
      "period_label":  "Q1 2026",
      "as_of_date":    "2026-03-31",
      "currency":      "MYR",
      "status":        "ok",
      "warnings":      0,
      "generated_at":  "2026-08-13T...",

      "reconciliation": {
        "bank": { ... },
        "statements": { ... },
        "gaps": [ ... ],
        "summary": { ... },
        "checks": [
          {
            "check": "bank_reconciliation",
            "left_label": "adjusted_book_balance",
            "left": 236255.10,
            "right_label": "adjusted_bank_balance",
            "right": 236255.10,
            "difference": 0.00,
            "status": "PASS"
          },
          ...
        ]
      }
    }

Environment
-----------
TABLE_NAME      default "auditai-output"
PK_NAME         default "PK"
SK_NAME         default "SK"
PK_PREFIX       default "run#"
ALLOWED_ORIGIN  default "*"

IAM: dynamodb:Query on the table ARN.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

TABLE_NAME     = os.environ.get("TABLE_NAME",    "auditai-output")
PK_NAME        = os.environ.get("PK_NAME",       "PK")
SK_NAME        = os.environ.get("SK_NAME",       "SK")
PK_PREFIX      = os.environ.get("PK_PREFIX",     "run#")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

ZERO = Decimal("0")
_TABLE = None


def _table():
    global _TABLE
    if _TABLE is None:
        _TABLE = boto3.resource("dynamodb").Table(TABLE_NAME)
    return _TABLE


# ────────────────────────── config ──────────────────────────

SK_CANDIDATES = (
    "reconciliation",
    "reconciliation_output",
    "recon",
    "pipeline",
    "result",
    "run",
)

YEAR_RE    = re.compile(r"^\d{4}$")
QUARTER_RE = re.compile(r"^(?P<year>\d{4})[-_ ]?(?P<q>[Qq][1-4])$")

STATUS_ALIASES = {
    "ok": "ok", "pass": "ok", "success": "ok", "clean": "ok",
    "balanced": "ok", "reconciled": "ok", "matched": "ok",
    "review": "review", "warn": "review", "warning": "review",
    "flagged": "review", "unreconciled": "review", "partial": "review",
    "error": "error", "fail": "error", "failed": "error", "alert": "error",
    "unmatched": "error",
}

# Human-readable label for each tie-out check
TIEOUT_CHECKS: List[Tuple[str, str, str, str]] = [
    # (check_key, left_field, left_label, right_field, right_label)
    # "net_income_match" is a boolean; we resolve it via the two numeric fields.
    ("net_income_tieout",
     "pnl_net_income",            "P&L Net Income",
     "balance_sheet_net_income",  "Balance Sheet Net Income"),
    ("accounting_equation",
     "total_assets",                   "Total Assets",
     "total_liabilities_and_equity",   "Total Liabilities & Equity"),
    ("trial_balance",
     "trial_balance_debits",   "Trial Balance Debits",
     "trial_balance_credits",  "Trial Balance Credits"),
]


# ────────────────────────── helpers ──────────────────────────

def _dec(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if value is None or isinstance(value, bool):
        return ZERO
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    cleaned = re.sub(r"[^0-9.\-]", "", str(value))
    if cleaned in ("", "-", ".", "-."):
        return ZERO
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return ZERO


def _f(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01")))


def _status(raw: Any) -> str:
    return STATUS_ALIASES.get(str(raw or "ok").strip().lower(), "ok")


def _response(code: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": code,
        "headers": {
            "Content-Type":                 "application/json",
            "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,x-api-key,Authorization",
            "Access-Control-Allow-Methods": "OPTIONS,POST",
            "Cache-Control":                "no-store",
        },
        "body": json.dumps(payload),
    }


def _parse_body(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get("body")
    if body is None:
        params = event.get("queryStringParameters") or {}
        if params.get("run_id"):
            return dict(params)
        return event if "run_id" in event else {}

    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    if isinstance(body, dict):
        return body
    try:
        parsed = json.loads(body or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError("Request body is not valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Request body must be a JSON object.")
    return parsed


def _expand_run_ids(run_id: str) -> Tuple[List[str], str]:
    run_id = str(run_id or "").strip()
    if not run_id:
        raise ValueError("run_id is required.")
    q = QUARTER_RE.match(run_id)
    if q:
        year, qtr = q.group("year"), q.group("q").upper()
        return [f"{year}-{qtr}"], f"{qtr} {year}"
    if YEAR_RE.match(run_id):
        return [run_id] + [f"{run_id}-Q{i}" for i in range(1, 5)], f"FY {run_id}"
    return [run_id], run_id


# ────────────────────────── data access ──────────────────────────

def _query_partition(run_id: str) -> List[Dict[str, Any]]:
    kwargs: Dict[str, Any] = {
        "KeyConditionExpression": Key(PK_NAME).eq(f"{PK_PREFIX}{run_id}")
    }
    items: List[Dict[str, Any]] = []
    while True:
        page = _table().query(**kwargs)
        items.extend(page.get("Items", []))
        last = page.get("LastEvaluatedKey")
        if not last:
            break
        kwargs["ExclusiveStartKey"] = last
    return items


def _looks_like_recon(node: Any) -> bool:
    return isinstance(node, dict) and (
        "bank_reconciliation" in node
        or "statement_tieout"  in node
        or "gaps"              in node
        or "unreconciled_difference" in node
    )


def _extract_recon(items: List[Dict[str, Any]]) -> Tuple[Optional[Dict], Dict]:
    fallback: Tuple[Optional[Dict], Dict] = (None, {})

    def rank(item: Dict[str, Any]) -> int:
        sk = str(item.get(SK_NAME, "")).lower()
        return SK_CANDIDATES.index(sk) if sk in SK_CANDIDATES else len(SK_CANDIDATES)

    for item in sorted(items, key=rank):
        nested = item.get("reconciliation_output")
        if _looks_like_recon(nested):
            return nested, item
        if _looks_like_recon(item):
            fallback = (item, item)

    return fallback


def _currency(recon: Dict[str, Any], envelope: Dict[str, Any]) -> str:
    for source in (recon, envelope):
        v = source.get("currency") if isinstance(source, dict) else None
        if v:
            return str(v)
    return os.environ.get("DEFAULT_CURRENCY", "MYR")


# ────────────────────────── shaping ──────────────────────────

def _shape_item(item: Any) -> Optional[Dict[str, Any]]:
    """Normalise one entry inside outstanding_checks / deposits_in_transit / etc."""
    if isinstance(item, dict):
        return {
            "description": str(item.get("description") or item.get("label") or ""),
            "amount":      _f(_dec(item.get("amount"))),
            "date":        item.get("date") or item.get("as_of_date") or "",
            "note":        str(item.get("note") or ""),
            "status":      _status(item.get("status")),
        }
    if isinstance(item, (int, float, Decimal, str)):
        return {"description": str(item), "amount": _f(_dec(item)), "date": "", "note": "", "status": "ok"}
    return None


def _shape_item_list(raw: Any) -> List[Dict[str, Any]]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [s for s in (_shape_item(i) for i in raw) if s]
    if isinstance(raw, dict):
        return [s for s in (_shape_item({"description": k, "amount": v}) for k, v in raw.items()) if s]
    return []


def _build_bank(
    bank: Dict[str, Any],
    filters: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Shape the bank_reconciliation block.

    Finance note: a bank reconciliation starts from TWO independent balances
    (your books vs the bank statement) and works toward a single agreed figure
    by listing outstanding items on each side. If both adjusted balances match,
    it's reconciled.
    """
    search       = (filters.get("search") or "").lower()
    min_amt      = _dec(filters.get("min_amount") or 0)
    hide_matched = filters.get("hide_matched", False)
    sf           = (filters.get("status_filter") or "").lower()

    def _filter_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        out = []
        for i in items:
            if search and search not in i["description"].lower() and search not in i["note"].lower():
                continue
            if abs(_dec(i["amount"])) < min_amt:
                continue
            if sf and _status(i["status"]) != _status(sf):
                continue
            out.append(i)
        return out

    outstanding_checks   = _filter_items(_shape_item_list(bank.get("outstanding_checks",   [])))
    deposits_in_transit  = _filter_items(_shape_item_list(bank.get("deposits_in_transit",  [])))
    bank_errors          = _filter_items(_shape_item_list(bank.get("bank_errors",           [])))
    book_errors          = _filter_items(_shape_item_list(bank.get("book_errors",           [])))

    book_balance  = _dec(bank.get("book_cash_balance",      bank.get("book_balance",  0)))
    bank_balance  = _dec(bank.get("bank_statement_balance", bank.get("bank_balance",  0)))
    adj_book      = _dec(bank.get("adjusted_book_balance",  book_balance))
    adj_bank      = _dec(bank.get("adjusted_bank_balance",  bank_balance))
    unrecon_diff  = _dec(bank.get("unreconciled_difference", adj_book - adj_bank))
    reconciled    = bank.get("reconciled", abs(unrecon_diff) <= Decimal("0.01"))

    result = {
        "book_cash_balance":      _f(book_balance),
        "bank_statement_balance": _f(bank_balance),
        "adjusted_book_balance":  _f(adj_book),
        "adjusted_bank_balance":  _f(adj_bank),
        "unreconciled_difference": _f(unrecon_diff),
        "reconciled":             bool(reconciled),
        "outstanding_checks":     outstanding_checks,
        "deposits_in_transit":    deposits_in_transit,
        "bank_errors":            bank_errors,
        "book_errors":            book_errors,
    }

    if hide_matched and bool(reconciled):
        return {}   # caller should skip this section if fully matched and hide_matched=true

    return result


def _build_statements(tieout: Dict[str, Any]) -> Dict[str, Any]:
    """
    Shape the statement_tieout block. Plain-language:
    'tie-out' means checking that every number that appears in two places
    (e.g. net income on the P&L AND on the balance sheet) is exactly the same.
    """
    issues = _shape_item_list(tieout.get("issues", []))

    return {
        "pnl_net_income":               _f(_dec(tieout.get("pnl_net_income", 0))),
        "balance_sheet_net_income":     _f(_dec(tieout.get("balance_sheet_net_income", 0))),
        "net_income_match":             bool(tieout.get("net_income_match", False)),
        "total_assets":                 _f(_dec(tieout.get("total_assets", 0))),
        "total_liabilities_and_equity": _f(_dec(tieout.get("total_liabilities_and_equity", 0))),
        "accounting_equation_balanced": bool(tieout.get("accounting_equation_balanced", False)),
        "trial_balance_debits":         _f(_dec(tieout.get("trial_balance_debits", 0))),
        "trial_balance_credits":        _f(_dec(tieout.get("trial_balance_credits", 0))),
        "trial_balance_balanced":       bool(tieout.get("trial_balance_balanced", False)),
        "issues":                       issues,
        "issues_count":                 len(issues),
    }


def _build_gaps(
    raw_gaps: List[Any],
    filters: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Gaps are items that couldn't be matched between book records and bank/statement.
    These are the items auditors focus on: each one needs an explanation.
    """
    search    = (filters.get("search") or "").lower()
    min_amt   = _dec(filters.get("min_amount") or 0)
    sf        = (filters.get("status_filter") or "").lower()

    gaps: List[Dict[str, Any]] = []
    for raw in (raw_gaps or []):
        if not isinstance(raw, dict):
            continue
        desc   = str(raw.get("description") or raw.get("label") or "")
        amount = _dec(raw.get("amount", 0))
        status = _status(raw.get("status"))

        if search and search not in desc.lower() and search not in str(raw.get("note", "")).lower():
            continue
        if abs(amount) < min_amt:
            continue
        if sf and status != _status(sf):
            continue

        gaps.append({
            "id":          str(raw.get("id") or ""),
            "description": desc,
            "amount":      _f(amount),
            "category":    str(raw.get("category") or ""),
            "status":      status,
            "note":        str(raw.get("note") or ""),
            "date":        str(raw.get("date") or ""),
        })

    return gaps


def _build_checks(
    bank: Optional[Dict[str, Any]],
    tieout: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Programmatic checks — same arithmetic the agent ran, surfaced for the frontend.

    Three checks:
      1. Bank reconciliation: adjusted_book_balance == adjusted_bank_balance
      2. Net income tie-out:  P&L net income == Balance Sheet net income
      3. Accounting equation: total_assets == total_liabilities_and_equity
      4. Trial balance:       debits == credits
    """
    checks: List[Dict[str, Any]] = []

    def _check(name, left_label, left: Decimal, right_label, right: Decimal) -> Dict:
        diff = left - right
        return {
            "check":       name,
            "left_label":  left_label,
            "left":        _f(left),
            "right_label": right_label,
            "right":       _f(right),
            "difference":  _f(diff),
            "status":      "PASS" if abs(diff) <= Decimal("0.01") else "FAIL",
        }

    if bank:
        checks.append(_check(
            "bank_reconciliation",
            "adjusted_book_balance", _dec(bank.get("adjusted_book_balance", 0)),
            "adjusted_bank_balance", _dec(bank.get("adjusted_bank_balance", 0)),
        ))

    if tieout:
        checks.append(_check(
            "net_income_tieout",
            "pnl_net_income",           _dec(tieout.get("pnl_net_income", 0)),
            "balance_sheet_net_income", _dec(tieout.get("balance_sheet_net_income", 0)),
        ))
        checks.append(_check(
            "accounting_equation",
            "total_assets",                  _dec(tieout.get("total_assets", 0)),
            "total_liabilities_and_equity",  _dec(tieout.get("total_liabilities_and_equity", 0)),
        ))
        checks.append(_check(
            "trial_balance",
            "trial_balance_debits",  _dec(tieout.get("trial_balance_debits", 0)),
            "trial_balance_credits", _dec(tieout.get("trial_balance_credits", 0)),
        ))

    return checks


def _build_summary(
    recon: Dict[str, Any],
    gaps: List[Dict[str, Any]],
    checks: List[Dict[str, Any]],
) -> Dict[str, Any]:
    raw_summary = recon.get("summary") or {}

    total_gap_amount = sum(abs(_dec(g["amount"])) for g in gaps)

    all_pass = all(c["status"] == "PASS" for c in checks)
    return {
        "total_gaps":          int(_dec(raw_summary.get("total_gaps",   len(gaps)))),
        "total_gap_amount":    _f(total_gap_amount),
        "reconciled":          bool(raw_summary.get("reconciled",          all_pass)),
        "statements_tied_out": bool(raw_summary.get("statements_tied_out", all_pass)),
        "transaction_count":   int(_dec(recon.get("transaction_count", 0))),
        "checks_passed":       sum(1 for c in checks if c["status"] == "PASS"),
        "checks_total":        len(checks),
    }


# ────────────────────────── handler ──────────────────────────

def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    method = (
        event.get("httpMethod")
        or (event.get("requestContext", {}).get("http", {}) or {}).get("method")
        or "POST"
    ).upper()
    if method == "OPTIONS":
        return _response(200, {"ok": True})

    try:
        body = _parse_body(event)
        requested = str(body.get("run_id") or "").strip()
        candidates, period_label = _expand_run_ids(requested)
    except ValueError as exc:
        return _response(400, {"message": str(exc)})

    filters = {
        "sections":      body.get("sections"),          # list[str] | None
        "search":        body.get("search"),             # str | None
        "min_amount":    body.get("min_amount"),         # numeric | None
        "status_filter": body.get("status_filter"),      # "pass"|"fail"|"review" | None
        "hide_matched":  bool(body.get("hide_matched")), # bool
    }

    recon_payload: Optional[Dict[str, Any]] = None
    envelope:      Dict[str, Any]           = {}
    found_ids:     List[str]                = []

    try:
        for candidate in candidates:
            items = _query_partition(candidate)
            if not items:
                continue
            recon, source_item = _extract_recon(items)
            if recon and recon_payload is None:
                recon_payload = recon
                envelope      = source_item
                found_ids.append(candidate)
    except (ClientError, BotoCoreError) as exc:
        LOG.exception("DynamoDB query failed for run_id=%s", requested)
        return _response(502, {
            "message": "Could not reach the audit data store.",
            "detail":  exc.__class__.__name__,
        })

    if recon_payload is None:
        return _response(404, {
            "message": f"No reconciliation data found for run_id '{requested}'.",
            "run_id":  requested,
        })

    # ── decide which top-level sections the caller wants ──
    wanted = filters.get("sections")
    wanted_set = {str(s).lower() for s in wanted} if wanted else None
    def _want(key: str) -> bool:
        return not wanted_set or key in wanted_set

    raw_bank   = recon_payload.get("bank_reconciliation") or {}
    raw_tieout = recon_payload.get("statement_tieout")    or {}
    raw_gaps   = recon_payload.get("gaps")                or []

    bank_block   = _build_bank(raw_bank, filters)   if (_want("bank") and raw_bank)   else None
    tieout_block = _build_statements(raw_tieout)     if (_want("statements") and raw_tieout) else None
    gap_list     = _build_gaps(raw_gaps, filters)    if _want("gaps")                  else []

    checks  = _build_checks(bank_block, tieout_block)
    summary = _build_summary(recon_payload, gap_list, checks)

    # ── warning count for the header badge ──
    warnings = 0
    if bank_block:
        warnings += len(bank_block.get("bank_errors",  []))
        warnings += len(bank_block.get("book_errors",  []))
        if not bank_block.get("reconciled"):
            warnings += 1
    if tieout_block:
        warnings += tieout_block.get("issues_count", 0)
    warnings += sum(1 for g in gap_list if g["status"] in ("review", "error"))
    warnings += sum(1 for c in checks if c["status"] != "PASS")

    period = recon_payload.get("period") or {}

    return _response(200, {
        "run_id":           requested,
        "resolved_run_ids": found_ids,
        "period_label":     period_label,
        "as_of_date":       recon_payload.get("as_of_date"),
        "period":           {"start": period.get("start"), "end": period.get("end")},
        "currency":         _currency(recon_payload, envelope),
        "status":           _status(recon_payload.get("status")),
        "warnings":         warnings,
        "generated_at":     (
            datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        ),
        "reconciliation": {
            "bank":       bank_block,
            "statements": tieout_block,
            "gaps":       gap_list,
            "summary":    summary,
            "checks":     checks,
        },
    })