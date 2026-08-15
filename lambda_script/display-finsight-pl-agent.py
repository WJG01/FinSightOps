"""
FinSightOps — Profit & Loss Lambda
==================================

API Gateway (proxy) -> Lambda -> DynamoDB

Request
-------
POST /profit-loss
    { "run_id": "2026-Q1" }

Optional filters in the same body:
    {
      "run_id": "2026-Q1",
      "sections": ["revenue", "cogs"],   # only these sections
      "min_amount": 1000,                # drop lines smaller than this (abs)
      "search": "consult",               # case-insensitive label match
      "hide_zero": true                  # drop zero-value lines
    }

If run_id is a bare year ("2026") the four quarters are fetched and rolled up.

Reads the run partition written by the pipeline:

    PK = "run#<run_id>"
    SK = "reconciliation" | "pnl" | "pipeline" | ...

The P&L payload is located wherever it lives in that partition — as a
top-level `pnl_output` on the pipeline item, as its own SK item, or as a
bare payload with `total_revenue` sitting directly on an item.

Source shape (from the pipeline):
    "pnl_output": {
      "status": "success",
      "period": {"start": "...", "end": "..."},
      "revenue_items": {"Revenue": 5000},
      "cogs_items": {},
      "expense_items": {},
      "total_revenue": 5000,
      "total_cogs": 0,
      "total_operating_expenses": 0,
      "gross_profit": 5000,
      "net_income": 5000,
      "transaction_count": 3
    }

Response (200):
    {
      "run_id": "...", "period_label": "...", "currency": "MYR",
      "warnings": 0,
      "profit_loss": {
        "sections": [{"key","title","kind","total","items":[
            {"label","amount","status","note"}]}],
        "summary": {...},
        "checks": [{"check","left","right","difference","status"}]
      }
    }

Environment
-----------
TABLE_NAME      required in practice; default "finsightops-runs"
PK_NAME         optional — read from the table's key schema if unset
SK_NAME         optional — read from the table's key schema if unset
PK_PREFIX       optional — if unset, both "<id>" and "run#<id>" are tried
DIAGNOSTICS     default "true"; set false in production
ALLOWED_ORIGIN  default "*"

IAM: dynamodb:Query on the table ARN. dynamodb:DescribeTable is optional but
lets the function discover the key schema instead of guessing.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from collections import OrderedDict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

TABLE_NAME = os.environ.get("TABLE_NAME", "auditai-output")
# Leave PK_NAME/SK_NAME unset to let the function read the table's real key
# schema at cold start. Set them to skip the DescribeTable call.
PK_NAME_ENV = os.environ.get("PK_NAME") or None
SK_NAME_ENV = os.environ.get("SK_NAME") or None
# PK_PREFIX unset -> both "<run_id>" and "run#<run_id>" are tried.
# Set it to "" to force the bare run_id, or "run#" to force the prefix.
PK_PREFIX_ENV = os.environ.get("PK_PREFIX")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
# Set DIAGNOSTICS=false once the endpoint is wired up — it echoes table metadata.
DIAGNOSTICS = os.environ.get("DIAGNOSTICS", "true").strip().lower() in ("1", "true", "yes")

ZERO = Decimal("0")
_TABLE = None
_KEYS: Optional[Dict[str, Any]] = None
# "Query condition missed key schema element: run_id"
MISSED_KEY_RE = re.compile(r"missed key schema element:\s*([A-Za-z0-9_.\-]+)")


def _table():
    global _TABLE
    if _TABLE is None:
        _TABLE = boto3.resource("dynamodb").Table(TABLE_NAME)
    return _TABLE


def _keys(refresh: bool = False) -> Dict[str, Any]:
    """
    Resolve the table's hash/range key names once per container.

    Order of precedence: PK_NAME/SK_NAME env vars -> DescribeTable -> "PK"/"SK".
    DescribeTable needs an extra IAM action; if it's missing we fall back
    quietly and the query error path will still self-correct.
    """
    global _KEYS
    if _KEYS is not None and not refresh:
        return _KEYS

    resolved = {"pk": PK_NAME_ENV, "sk": SK_NAME_ENV, "source": "env"}

    if not resolved["pk"]:
        try:
            described = boto3.client("dynamodb").describe_table(TableName=TABLE_NAME)
            schema = {
                k["KeyType"]: k["AttributeName"] for k in described["Table"]["KeySchema"]
            }
            resolved = {
                "pk": schema.get("HASH"),
                "sk": SK_NAME_ENV or schema.get("RANGE"),
                "source": "describe_table",
            }
            LOG.info("Resolved key schema from DescribeTable: %s", resolved)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("DescribeTable unavailable (%s); defaulting to PK/SK",
                        exc.__class__.__name__)
            resolved = {"pk": "PK", "sk": SK_NAME_ENV or "SK", "source": "default"}

    _KEYS = resolved
    return _KEYS


def _set_pk_name(name: str) -> None:
    """Called when DynamoDB tells us the real key name in an error message."""
    global _KEYS
    _KEYS = {"pk": name, "sk": SK_NAME_ENV, "source": "error_recovery"}
    LOG.info("Learned hash key name from ValidationException: %s", name)


def _pk_values(run_id: str, pk_name: str) -> List[str]:
    """
    Candidate partition-key values, most likely first.

    A key literally called run_id almost certainly holds a bare id; a key
    called PK in a single-table design almost certainly holds "run#<id>".
    Whichever is wrong just returns zero items, so both are tried.
    """
    if PK_PREFIX_ENV is not None:
        return [f"{PK_PREFIX_ENV}{run_id}"]

    bare_first = pk_name.lower() in ("run_id", "runid", "run", "id")
    candidates = [run_id, f"run#{run_id}"] if bare_first else [f"run#{run_id}", run_id]
    return list(dict.fromkeys(candidates))


# ────────────────────────── config ──────────────────────────

# source map key -> (section key, title, kind, declared-total fields)
SECTION_SPECS: "OrderedDict[str, Tuple[str, str, str, Tuple[str, ...]]]" = OrderedDict(
    [
        ("revenue_items", ("revenue", "Revenue", "income", ("total_revenue",))),
        ("cogs_items", ("cogs", "Cost of Goods Sold", "expense", ("total_cogs",))),
        (
            "expense_items",
            (
                "operating_expenses",
                "Operating Expenses",
                "expense",
                ("total_operating_expenses", "total_expenses"),
            ),
        ),
        (
            "other_income_items",
            ("other_income", "Other Income", "income", ("total_other_income",)),
        ),
        (
            "other_expense_items",
            ("other_expenses", "Other Expenses", "expense", ("total_other_expenses",)),
        ),
        ("tax_items", ("taxes", "Tax Expense", "expense", ("total_tax", "total_taxes"))),
    ]
)

SK_CANDIDATES = ("pnl", "pnl_output", "profit_loss", "pipeline", "result", "run")
YEAR_RE = re.compile(r"^\d{4}$")
QUARTER_RE = re.compile(r"^(?P<year>\d{4})[-_ ]?(?P<q>[Qq][1-4])$")

# Anything the P&L stage might report, folded onto the three frontend tones.
STATUS_ALIASES = {
    "ok": "ok", "pass": "ok", "success": "ok", "clean": "ok", "balanced": "ok",
    "review": "review", "warn": "review", "warning": "review", "flagged": "review",
    "error": "error", "fail": "error", "failed": "error", "alert": "error",
}


# ────────────────────────── helpers ──────────────────────────


def _dec(value: Any) -> Decimal:
    """Coerce Decimal / int / float / '5,300.00' / None into a Decimal."""
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


def _pct(part: Decimal, whole: Decimal) -> Optional[float]:
    return None if whole == 0 else round(float(part / whole) * 100, 1)


def _status(raw: Any) -> str:
    return STATUS_ALIASES.get(str(raw or "ok").strip().lower(), "ok")


def _response(code: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,x-api-key,Authorization",
            "Access-Control-Allow-Methods": "OPTIONS,POST",
            "Cache-Control": "no-store",
        },
        "body": json.dumps(payload),
    }


def _parse_body(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get("body")

    if body is None:  # direct invoke / console test, or GET ?run_id=
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
    """
    "2026-Q1" -> (["2026-Q1"], "Q1 2026")
    "2026"    -> (["2026", "2026-Q1" ... "2026-Q4"], "FY 2026")
    Anything else is treated as an opaque id (e.g. "Q1-2024-test").
    """
    run_id = str(run_id or "").strip()
    if not run_id:
        raise ValueError("run_id is required.")

    quarter = QUARTER_RE.match(run_id)
    if quarter:
        year, q = quarter.group("year"), quarter.group("q").upper()
        return [f"{year}-{q}"], f"{q} {year}"

    if YEAR_RE.match(run_id):
        return [run_id] + [f"{run_id}-Q{i}" for i in range(1, 5)], f"FY {run_id}"

    return [run_id], run_id


# ────────────────────────── data access ──────────────────────────


def _client_error_detail(exc: Exception) -> Dict[str, Any]:
    """Pull the useful bits out of a botocore ClientError."""
    info = getattr(exc, "response", {}).get("Error", {}) if hasattr(exc, "response") else {}
    return {
        "code": info.get("Code") or exc.__class__.__name__,
        "aws_message": info.get("Message") or str(exc),
    }


def _describe_table() -> Dict[str, Any]:
    """
    Best-effort look at the table so a key-name mismatch is obvious from the
    error response instead of requiring a console trip. Needs
    dynamodb:DescribeTable; silently degrades if that permission is absent.
    """
    try:
        client = boto3.client("dynamodb")
        described = client.describe_table(TableName=TABLE_NAME)["Table"]
        schema = {k["KeyType"]: k["AttributeName"] for k in described["KeySchema"]}
        return {
            "table": TABLE_NAME,
            "region": client.meta.region_name,
            "actual_hash_key": schema.get("HASH"),
            "actual_range_key": schema.get("RANGE"),
            "configured_pk_name": _keys()["pk"],
            "configured_sk_name": _keys()["sk"],
            "key_source": _keys()["source"],
            "key_names_match": schema.get("HASH") == _keys()["pk"],
            "indexes": [
                i["IndexName"] for i in described.get("GlobalSecondaryIndexes", [])
            ],
        }
    except Exception as exc:  # noqa: BLE001 - diagnostics must never mask the real error
        return {"table": TABLE_NAME, "describe_failed": exc.__class__.__name__}


def _query_once(pk_name: str, pk_value: str) -> List[Dict[str, Any]]:
    kwargs: Dict[str, Any] = {"KeyConditionExpression": Key(pk_name).eq(pk_value)}
    items: List[Dict[str, Any]] = []
    while True:
        page = _table().query(**kwargs)
        items.extend(page.get("Items", []))
        last = page.get("LastEvaluatedKey")
        if not last:
            break
        kwargs["ExclusiveStartKey"] = last
    return items


def _query_partition(run_id: str) -> List[Dict[str, Any]]:
    """
    Query the run's partition, tolerating two common layout differences:

      * the hash key may be `run_id` or a single-table `PK`
      * its value may be the bare run id or prefixed with "run#"

    A wrong key NAME raises ValidationException, and DynamoDB helpfully names
    the correct one — so that error is caught once, the name is cached, and the
    query is retried. A wrong key VALUE just returns nothing, so each candidate
    value is tried until one yields items.
    """
    pk_name = _keys()["pk"]

    for attempt in range(2):
        try:
            for pk_value in _pk_values(run_id, pk_name):
                items = _query_once(pk_name, pk_value)
                if items:
                    return items
            return []
        except ClientError as exc:
            message = _client_error_detail(exc)["aws_message"]
            match = MISSED_KEY_RE.search(message or "")
            if attempt == 0 and match and match.group(1) != pk_name:
                pk_name = match.group(1)
                _set_pk_name(pk_name)
                continue
            raise

    return []


def _looks_like_pnl(node: Any) -> bool:
    return isinstance(node, dict) and (
        "total_revenue" in node or "revenue_items" in node or "net_income" in node
    )


def _extract_pnl(items: List[Dict[str, Any]]) -> Tuple[Optional[Dict], Dict]:
    """
    Find the P&L payload in a run partition. Returns (pnl_output, envelope),
    where envelope is the item it came from (used for currency / status).

    Handles three layouts:
      1. one item holding the whole pipeline result -> item["pnl_output"]
      2. a dedicated item, SK in SK_CANDIDATES      -> item["pnl_output"] or item
      3. the P&L fields sitting directly on an item
    """
    fallback: Tuple[Optional[Dict], Dict] = (None, {})

    def rank(item: Dict[str, Any]) -> int:
        sk = str(item.get(_keys()["sk"] or "SK", "")).lower()
        return SK_CANDIDATES.index(sk) if sk in SK_CANDIDATES else len(SK_CANDIDATES)

    for item in sorted(items, key=rank):
        nested = item.get("pnl_output")
        if _looks_like_pnl(nested):
            return nested, item
        if _looks_like_pnl(item):
            fallback = (item, item)

    return fallback


def _currency(pnl: Dict[str, Any], envelope: Dict[str, Any]) -> str:
    ledger = envelope.get("ledger_output") if isinstance(envelope, dict) else None
    for source in (pnl, envelope, ledger or {}):
        value = source.get("currency") if isinstance(source, dict) else None
        if value:
            return str(value)
    return os.environ.get("DEFAULT_CURRENCY", "MYR")


# ────────────────────────── shaping ──────────────────────────


def _merge_pnl(payloads: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Roll several quarterly pnl_output blocks into one (full-year request)."""
    if len(payloads) == 1:
        return payloads[0]

    merged: Dict[str, Any] = {"status": "success"}

    for source_key in SECTION_SPECS:
        bucket: "OrderedDict[str, Decimal]" = OrderedDict()
        for payload in payloads:
            for label, amount in (payload.get(source_key) or {}).items():
                bucket[label] = bucket.get(label, ZERO) + _dec(amount)
        if bucket:
            merged[source_key] = bucket

    # Declared totals are only trustworthy if EVERY quarter declares them —
    # a partial sum would look like an unreconciled difference downstream.
    declared_fields = (
        "total_revenue", "total_cogs", "total_expenses", "total_operating_expenses",
        "total_other_income", "total_other_expenses", "total_tax",
        "gross_profit", "net_income",
    )
    for field in declared_fields:
        if all(p.get(field) is not None for p in payloads):
            merged[field] = sum((_dec(p[field]) for p in payloads), ZERO)

    counts = [p["transaction_count"] for p in payloads if p.get("transaction_count") is not None]
    if counts:
        merged["transaction_count"] = sum((_dec(c) for c in counts), ZERO)

    starts = [s for s in ((p.get("period") or {}).get("start") for p in payloads) if s]
    ends = [e for e in ((p.get("period") or {}).get("end") for p in payloads) if e]
    if starts or ends:
        merged["period"] = {
            "start": min(starts) if starts else None,
            "end": max(ends) if ends else None,
        }

    if any(_status(p.get("status")) != "ok" for p in payloads):
        merged["status"] = "review"
    return merged


def _passes_filters(label: str, amount: Decimal, filters: Dict[str, Any]) -> bool:
    if filters.get("hide_zero") and amount == 0:
        return False
    min_amount = filters.get("min_amount")
    if min_amount is not None and abs(amount) < _dec(min_amount):
        return False
    search = filters.get("search")
    if search and str(search).lower() not in label.lower():
        return False
    return True


def _build_sections(
    pnl: Dict[str, Any], filters: Dict[str, Any]
) -> Tuple[List[Dict[str, Any]], Dict[str, Decimal]]:
    wanted = filters.get("sections")
    wanted = {str(s).lower() for s in wanted} if wanted else None

    sections: List[Dict[str, Any]] = []
    totals: Dict[str, Decimal] = {}

    for source_key, (key, title, kind, total_fields) in SECTION_SPECS.items():
        raw_items = pnl.get(source_key)
        declared = next(
            (_dec(pnl[f]) for f in total_fields if pnl.get(f) is not None), None
        )
        if not raw_items and declared is None:
            continue
        if wanted and key not in wanted:
            continue

        items: List[Dict[str, Any]] = []
        computed = ZERO

        for label, raw_amount in (raw_items or {}).items():
            amount = _dec(raw_amount)
            computed += amount
            if not _passes_filters(str(label), amount, filters):
                continue

            status, note = "ok", ""
            if kind == "income" and amount < 0:
                status, note = "review", "Negative amount in an income section."
            elif kind == "expense" and amount < 0:
                status, note = "review", "Credit/contra line in an expense section."

            items.append(
                {
                    "label": str(label),
                    "amount": _f(amount),
                    "status": status,
                    "note": note,
                }
            )

        # Declared total wins; flag it when the lines don't add up to it.
        section_total = declared if declared is not None else computed
        section_note = ""
        if declared is not None and raw_items and abs(declared - computed) > Decimal("0.01"):
            section_note = (
                f"Declared total {_f(declared)} differs from the sum of lines "
                f"{_f(computed)}."
            )
            items.append(
                {
                    "label": "Unreconciled difference",
                    "amount": _f(declared - computed),
                    "status": "error",
                    "note": section_note,
                }
            )

        totals[key] = section_total
        sections.append(
            {
                "key": key,
                "title": title,
                "kind": kind,
                "total": _f(section_total),
                "note": section_note,
                "line_count": len(raw_items or {}),
                "items": items,
            }
        )

    return sections, totals


def _build_summary(pnl: Dict[str, Any], totals: Dict[str, Decimal]) -> Dict[str, Any]:
    get = lambda k: totals.get(k, ZERO)  # noqa: E731

    revenue = get("revenue")
    cogs = get("cogs")
    opex = get("operating_expenses")
    other_income = get("other_income")
    other_expenses = get("other_expenses")
    taxes = get("taxes")

    gross_profit = (
        _dec(pnl["gross_profit"])
        if pnl.get("gross_profit") is not None
        else revenue - cogs
    )
    operating_income = gross_profit - opex
    pre_tax = operating_income + other_income - other_expenses
    net_income = (
        _dec(pnl["net_income"]) if pnl.get("net_income") is not None else pre_tax - taxes
    )

    return {
        "revenue": _f(revenue),
        "cogs": _f(cogs),
        "gross_profit": _f(gross_profit),
        "operating_expenses": _f(opex),
        "operating_income": _f(operating_income),
        "other_income": _f(other_income),
        "other_expenses": _f(other_expenses),
        "pre_tax_income": _f(pre_tax),
        "taxes": _f(taxes),
        "net_income": _f(net_income),
        "gross_margin": _pct(gross_profit, revenue),
        "operating_margin": _pct(operating_income, revenue),
        "net_margin": _pct(net_income, revenue),
        "transaction_count": int(_dec(pnl.get("transaction_count", 0))),
    }


def _build_checks(totals: Dict[str, Decimal], summary: Dict[str, Any]) -> List[Dict]:
    """The same arithmetic the reconciliation agent runs, so the page can show it."""
    revenue = totals.get("revenue", ZERO)
    cogs = totals.get("cogs", ZERO)
    opex = totals.get("operating_expenses", ZERO)

    def compare(name, left_label, left: Decimal, right_label, right: Decimal):
        diff = left - right
        return {
            "check": name,
            "left_label": left_label,
            "left": _f(left),
            "right_label": right_label,
            "right": _f(right),
            "difference": _f(diff),
            "status": "PASS" if abs(diff) <= Decimal("0.01") else "FAIL",
        }

    return [
        compare(
            "gross_profit_arithmetic",
            "revenue_less_cogs", revenue - cogs,
            "pnl_gross_profit", _dec(summary["gross_profit"]),
        ),
        compare(
            "pnl_arithmetic",
            "revenue_less_costs", revenue - cogs - opex,
            "pnl_net_income", _dec(summary["net_income"]),
        ),
    ]


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
    except ValueError as exc:
        return _response(400, {"message": str(exc)})

    # POST {"diagnose": true} -> report table wiring without touching data.
    if body.get("diagnose"):
        return _response(200, {"diagnostics": _describe_table()})

    try:
        requested = str(body.get("run_id") or "").strip()
        candidates, period_label = _expand_run_ids(requested)
    except ValueError as exc:
        return _response(400, {"message": str(exc)})

    filters = {
        "sections": body.get("sections"),
        "min_amount": body.get("min_amount"),
        "search": body.get("search"),
        "hide_zero": bool(body.get("hide_zero")),
    }

    payloads: List[Dict[str, Any]] = []
    envelope: Dict[str, Any] = {}
    found_ids: List[str] = []

    try:
        for candidate in candidates:
            items = _query_partition(candidate)
            if not items:
                continue
            pnl, source_item = _extract_pnl(items)
            if pnl:
                payloads.append(pnl)
                found_ids.append(candidate)
                envelope = envelope or source_item
    except (ClientError, BotoCoreError) as exc:
        detail = _client_error_detail(exc)
        pk_name = _keys()["pk"]
        LOG.error(
            "DynamoDB query failed run_id=%s table=%s pk=%s code=%s msg=%s",
            requested, TABLE_NAME, pk_name, detail["code"], detail["aws_message"],
        )
        payload = {
            "message": "Could not reach the audit data store.",
            "detail": detail["code"],
            "aws_message": detail["aws_message"],
            "queried": {
                "table": TABLE_NAME,
                "hash_key": pk_name,
                "key_source": _keys()["source"],
                "values_tried": _pk_values(requested, pk_name),
            },
        }
        if DIAGNOSTICS:
            payload["diagnostics"] = _describe_table()
        return _response(502, payload)

    if not payloads:
        return _response(
            404,
            {
                "message": f"No profit & loss data found for run_id '{requested}'.",
                "run_id": requested,
            },
        )

    pnl = _merge_pnl(payloads)
    sections, totals = _build_sections(pnl, filters)
    summary = _build_summary(pnl, totals)
    checks = _build_checks(totals, summary)

    warnings = sum(
        1 for s in sections for i in s["items"] if i["status"] != "ok"
    ) + sum(1 for c in checks if c["status"] != "PASS")

    period = pnl.get("period") or {}

    return _response(
        200,
        {
            "run_id": requested,
            "resolved_run_ids": found_ids,
            "period_label": period_label,
            "period": {"start": period.get("start"), "end": period.get("end")},
            "currency": _currency(pnl, envelope),
            "status": _status(pnl.get("status")),
            "warnings": warnings,
            "generated_at": datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "profit_loss": {
                "sections": sections,
                "summary": summary,
                "checks": checks,
            },
        },
    )