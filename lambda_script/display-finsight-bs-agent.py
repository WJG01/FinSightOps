"""
FinSightOps — Balance Sheet Lambda
==================================

API Gateway (proxy) -> Lambda -> DynamoDB

Request
-------
POST /balance-sheet
    { "run_id": "2026-Q1" }

Optional filters in the same body:
    {
      "run_id": "2026-Q1",
      "sections": ["assets", "liabilities"],  # only these top-level sections
      "min_amount": 1000,                     # drop lines smaller than this (abs)
      "search": "cash",                       # case-insensitive label match
      "hide_zero": true                       # drop zero-value lines
    }

    { "diagnose": true }                      # report table wiring, touch no data

Reads the run partition written by the pipeline. Both of these layouts work:

    hash key "run_id" holding "2026-Q1"      (bare id)
    hash key "PK"     holding "run#2026-Q1"  (single-table)

The key schema is read from the table at cold start rather than assumed; see
_keys(). The Balance Sheet payload is then located wherever it lives in the
partition — nested as `balance_sheet_output`, on its own SK item, or with the
fields sitting directly on an item.

Expected source shape (from the Balance Sheet agent):
    "balance_sheet_output": {
      "status": "success",
      "as_of_date": "2026-03-31",
      "period": {"start": "2026-01-01", "end": "2026-03-31"},
      "assets": {
        "current_assets":     {"Cash": 50000, "Accounts Receivable": 30000},
        "non_current_assets": {"Equipment": 120000, "Intangibles": 20000}
      },
      "liabilities": {
        "current_liabilities":     {"Accounts Payable": 25000},
        "non_current_liabilities": {"Long-term Debt": 80000}
      },
      "equity": {"Share Capital": 50000, "Retained Earnings": 60000},
      "total_assets": 220000,
      "total_liabilities": 105000,
      "total_equity": 110000,
      "net_income": 28915.10,
      "transaction_count": 42
    }

The agent may also emit a flat structure — assets/liabilities/equity as dicts
of label->amount with no sub-groups. Both layouts are handled.

Environment
-----------
TABLE_NAME      default "auditai-output"
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
    quietly and the query error path still self-corrects.
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
            LOG.warning(
                "DescribeTable unavailable (%s); defaulting to PK/SK",
                exc.__class__.__name__,
            )
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

# The three top-level buckets in a balance sheet, in order.
# key -> (display title, kind)
TOP_SECTIONS = [
    ("assets", "Assets", "asset"),
    ("liabilities", "Liabilities", "liability"),
    ("equity", "Equity", "equity"),
]

# Sub-group display labels — any key not listed here is title-cased as-is.
GROUP_LABELS: Dict[str, str] = {
    "current_assets": "Current Assets",
    "non_current_assets": "Non-Current Assets",
    "fixed_assets": "Fixed Assets",
    "intangible_assets": "Intangible Assets",
    "current_liabilities": "Current Liabilities",
    "non_current_liabilities": "Non-Current Liabilities",
    "long_term_liabilities": "Long-Term Liabilities",
    "shareholders_equity": "Shareholders' Equity",
    "owners_equity": "Owners' Equity",
}

# SK values the pipeline might use for the balance sheet item.
SK_CANDIDATES = (
    "balance_sheet",
    "balance_sheet_output",
    "balancesheet",
    "pipeline",
    "result",
    "run",
)

YEAR_RE = re.compile(r"^\d{4}$")
QUARTER_RE = re.compile(r"^(?P<year>\d{4})[-_ ]?(?P<q>[Qq][1-4])$")

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

    if body is None:
        params = event.get("queryStringParameters") or {}
        if params.get("run_id"):
            return dict(params)
        return event if ("run_id" in event or "diagnose" in event) else {}

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
    dynamodb:DescribeTable; degrades quietly if that permission is absent.
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
            "item_count": described.get("ItemCount"),
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

    A wrong key NAME raises ValidationException, and DynamoDB names the correct
    one — so that error is caught once, the name cached, and the query retried.
    A wrong key VALUE just returns nothing, so each candidate value is tried
    until one yields items.
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


def _looks_like_bs(node: Any) -> bool:
    """Recognise a balance_sheet_output payload by its characteristic fields."""
    return isinstance(node, dict) and (
        "total_assets" in node
        or "assets" in node
        or "total_liabilities" in node
        or "total_equity" in node
    )


def _unwrap_bs(node: Any) -> Optional[Dict[str, Any]]:
    """
    The pipeline wraps the figures one level deeper:

        balance_sheet_output: {status, run_id, balance_sheet: {assets, ...}}

    Flatten that, keeping outer metadata (status, as_of_date, period, currency)
    that the inner dict doesn't carry. Payloads without the wrapper pass
    through unchanged.
    """
    if not isinstance(node, dict):
        return None

    inner = node.get("balance_sheet")
    if _looks_like_bs(inner):
        merged = dict(inner)
        for key, value in node.items():
            if key != "balance_sheet" and key not in merged:
                merged[key] = value
        return merged

    return node if _looks_like_bs(node) else None


def _extract_bs(items: List[Dict[str, Any]]) -> Tuple[Optional[Dict], Dict]:
    """
    Return (balance_sheet_output, envelope_item).
    Priority: dedicated SK > nested key on pipeline item > bare fields on any item.
    """
    fallback: Tuple[Optional[Dict], Dict] = (None, {})
    sk_name = _keys()["sk"] or "SK"

    def rank(item: Dict[str, Any]) -> int:
        sk = str(item.get(sk_name, "")).lower()
        return SK_CANDIDATES.index(sk) if sk in SK_CANDIDATES else len(SK_CANDIDATES)

    for item in sorted(items, key=rank):
        nested = _unwrap_bs(item.get("balance_sheet_output"))
        if nested:
            return nested, item
        direct = _unwrap_bs(item)
        if direct:
            fallback = (direct, item)

    return fallback


def _currency(bs: Dict[str, Any], envelope: Dict[str, Any]) -> str:
    ledger = envelope.get("ledger_output") if isinstance(envelope, dict) else None
    for source in (bs, envelope, ledger or {}):
        value = source.get("currency") if isinstance(source, dict) else None
        if value:
            return str(value)
    return os.environ.get("DEFAULT_CURRENCY", "MYR")


# ────────────────────────── shaping ──────────────────────────


def _group_title(key: str) -> str:
    return GROUP_LABELS.get(key, key.replace("_", " ").title())


def _passes_filters(label: str, amount: Decimal, filters: Dict[str, Any]) -> bool:
    if filters.get("hide_zero") and amount == ZERO:
        return False
    min_amt = filters.get("min_amount")
    if min_amt is not None and abs(amount) < _dec(min_amt):
        return False
    search = filters.get("search")
    if search and str(search).lower() not in label.lower():
        return False
    return True


def _line_item(label: str, amount: Decimal, kind: str) -> Dict[str, Any]:
    status, note = "ok", ""
    if kind == "asset" and amount < ZERO:
        status, note = "review", "Negative asset — verify contra-asset treatment."
    elif kind == "liability" and amount < ZERO:
        status, note = "review", "Negative liability — verify or reclassify."
    elif kind == "equity" and amount < ZERO:
        status, note = "review", "Negative equity line — may indicate accumulated losses."
    return {"label": str(label), "amount": _f(amount), "status": status, "note": note}


def _build_group(
    group_key: str, raw: Dict[str, Any], kind: str, filters: Dict[str, Any]
) -> Tuple[Dict[str, Any], Decimal]:
    """Build one sub-group block. Returns (group_dict, computed_total)."""
    items: List[Dict[str, Any]] = []
    computed = ZERO

    for label, raw_amount in raw.items():
        amount = _dec(raw_amount)
        computed += amount
        if _passes_filters(str(label), amount, filters):
            items.append(_line_item(label, amount, kind))

    return {
        "key": group_key,
        "title": _group_title(group_key),
        "total": _f(computed),
        "items": items,
    }, computed


def _build_sections(
    bs: Dict[str, Any], filters: Dict[str, Any]
) -> Tuple[List[Dict[str, Any]], Dict[str, Decimal]]:
    """
    Build the sections list and a totals dict keyed by top-level section key.
    Handles both:
      - grouped layout: bs["assets"] = {"current_assets": {...}, ...}
      - flat layout:    bs["assets"] = {"Cash": 50000, ...}
    """
    wanted = filters.get("sections")
    wanted_set = {str(s).lower() for s in wanted} if wanted else None

    sections: List[Dict[str, Any]] = []
    totals: Dict[str, Decimal] = {}

    for sec_key, sec_title, kind in TOP_SECTIONS:
        if wanted_set and sec_key not in wanted_set:
            continue

        raw_section = bs.get(sec_key)
        if not raw_section:
            continue

        declared_total_key = f"total_{sec_key}"
        declared = (
            _dec(bs[declared_total_key])
            if bs.get(declared_total_key) is not None
            else None
        )

        groups: List[Dict[str, Any]] = []
        flat_items: List[Dict[str, Any]] = []
        section_computed = ZERO

        has_subgroups = any(isinstance(v, dict) for v in raw_section.values())

        if has_subgroups:
            for group_key, group_raw in raw_section.items():
                if not isinstance(group_raw, dict):
                    continue
                group_dict, group_total = _build_group(group_key, group_raw, kind, filters)
                groups.append(group_dict)
                section_computed += group_total
        else:
            for label, raw_amount in raw_section.items():
                amount = _dec(raw_amount)
                section_computed += amount
                if _passes_filters(str(label), amount, filters):
                    flat_items.append(_line_item(label, amount, kind))

        section_total = declared if declared is not None else section_computed

        section_note = ""
        if declared is not None and abs(declared - section_computed) > Decimal("0.01"):
            diff = declared - section_computed
            section_note = (
                f"Declared total {_f(declared)} differs from sum of lines "
                f"{_f(section_computed)} (difference: {_f(diff)})."
            )
            target = (
                flat_items
                if not has_subgroups
                else (groups[-1]["items"] if groups else flat_items)
            )
            target.append(
                {
                    "label": "Unreconciled difference",
                    "amount": _f(diff),
                    "status": "error",
                    "note": section_note,
                }
            )

        totals[sec_key] = section_total
        sections.append(
            {
                "key": sec_key,
                "title": sec_title,
                "kind": kind,
                "total": _f(section_total),
                "note": section_note,
                "groups": groups,
                "items": flat_items,  # non-empty only for flat layouts
            }
        )

    return sections, totals


def _build_summary(bs: Dict[str, Any], totals: Dict[str, Decimal]) -> Dict[str, Any]:
    total_assets = totals.get("assets", ZERO)
    total_liabilities = totals.get("liabilities", ZERO)
    total_equity = totals.get("equity", ZERO)

    return {
        "total_assets": _f(total_assets),
        "total_liabilities": _f(total_liabilities),
        "total_equity": _f(total_equity),
        "total_liabilities_and_equity": _f(total_liabilities + total_equity),
        "net_income": _f(_dec(bs.get("net_income", 0))),
        "transaction_count": int(_dec(bs.get("transaction_count", 0))),
    }


def _build_checks(totals: Dict[str, Decimal], summary: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    The fundamental accounting equation: Assets = Liabilities + Equity.
    A non-zero difference means the pipeline agent produced an unbalanced
    balance sheet — surfaced here so the frontend can flag it.
    """
    total_assets = totals.get("assets", ZERO)
    total_liab_equity = totals.get("liabilities", ZERO) + totals.get("equity", ZERO)
    diff = total_assets - total_liab_equity

    return [
        {
            "check": "accounting_equation",
            "left_label": "total_assets",
            "left": _f(total_assets),
            "right_label": "total_liabilities_and_equity",
            "right": _f(total_liab_equity),
            "difference": _f(diff),
            "status": "PASS" if abs(diff) <= Decimal("0.01") else "FAIL",
        }
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
        "sections": body.get("sections"),      # list[str] | None
        "min_amount": body.get("min_amount"),  # numeric | None
        "search": body.get("search"),          # str | None
        "hide_zero": bool(body.get("hide_zero")),
    }

    bs_payload: Optional[Dict[str, Any]] = None
    envelope: Dict[str, Any] = {}
    found_ids: List[str] = []

    try:
        for candidate in candidates:
            items = _query_partition(candidate)
            if not items:
                continue
            bs, source_item = _extract_bs(items)
            if bs:
                # A balance sheet is a snapshot, not a flow — quarters are NOT
                # additive, so a full-year request keeps one payload rather than
                # summing. See the note in the README about which one.
                if bs_payload is None:
                    bs_payload = bs
                    envelope = source_item
                found_ids.append(candidate)
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

    if bs_payload is None:
        return _response(
            404,
            {
                "message": f"No balance sheet data found for run_id '{requested}'.",
                "run_id": requested,
            },
        )

    sections, totals = _build_sections(bs_payload, filters)
    summary = _build_summary(bs_payload, totals)
    checks = _build_checks(totals, summary)

    warnings = (
        sum(1 for s in sections for g in s["groups"] for i in g["items"] if i["status"] != "ok")
        + sum(1 for s in sections for i in s["items"] if i["status"] != "ok")
        + sum(1 for c in checks if c["status"] != "PASS")
    )

    period = bs_payload.get("period") or {}

    return _response(
        200,
        {
            "run_id": requested,
            "resolved_run_ids": found_ids,
            "period_label": period_label,
            "as_of_date": bs_payload.get("as_of_date"),
            "period": {"start": period.get("start"), "end": period.get("end")},
            "currency": _currency(bs_payload, envelope),
            "status": _status(bs_payload.get("status")),
            "warnings": warnings,
            "generated_at": (
                datetime.now(timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z")
            ),
            "balance_sheet": {
                "sections": sections,
                "summary": summary,
                "checks": checks,
            },
        },
    )