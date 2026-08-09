"""
ledger_agent/handler.py
Ledger Agent — converts extraction output into double-entry journal entries
and rolls them up into a trial balance.

Region  : ap-southeast-1 (Singapore)
Model   : Claude Sonnet 4.6 via cross-Region inference profile
          Set BEDROCK_PROFILE_ID env var to the profile ID, e.g.
          global.anthropic.claude-sonnet-4-6-20250514
          (run: aws bedrock list-inference-profiles --region ap-southeast-1)

Money rule: Decimal everywhere, never float.
            json.loads(raw, parse_float=Decimal) at every LLM parse point.

Output contract (returned from handler + written to DynamoDB):
{
  "status": "balanced",
  "run_id": "...",
  "schema_version": "1.0",
  "currency": "MYR",
  "trial_balance": {
    "accounts": [
      {
        "account_code": "1000",
        "account_name": "Cash",
        "account_type": "Asset",
        "debit_total": "233915.10",
        "credit_total": "0.00",
        "net_balance": "233915.10"
      }
    ],
    "total_debit": "819000.00",
    "total_credit": "819000.00",
    "is_balanced": true,
    "imbalance": "0.00",
    "period": {"start": "2026-01-01", "end": "2026-08-08"}
  },
  "journal_entry_count": 42,
  "errors": []
}

This is what P&L, Balance Sheet, and Reconciliation agents will read from DynamoDB.
"""

import json
import os
import uuid
import logging
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# ── Constants ──────────────────────────────────────────────────────────────

REGION          = "ap-southeast-1"
DYNAMO_TABLE    = os.environ.get("DYNAMO_TABLE", "auditai-ledger")
BEDROCK_PROFILE = os.environ.get("BEDROCK_PROFILE_ID")   # MUST be set
MAX_TOKENS      = 512       # categorisation needs very few output tokens
SCHEMA_VERSION  = "1.1"
TWO_PLACES      = Decimal("0.01")

# Single source of truth for the chart of accounts.
# If you add codes here, also add them to the Bedrock prompt below.
CHART_OF_ACCOUNTS: dict[str, dict] = {
    "1000": {"name": "Cash",                        "type": "Asset"},
    "1100": {"name": "Accounts Receivable",         "type": "Asset"},
    "1200": {"name": "Inventory",                   "type": "Asset"},
    "1500": {"name": "Fixed Assets",                "type": "Asset"},
    "2000": {"name": "Accounts Payable",            "type": "Liability"},
    "2100": {"name": "Loans Payable",               "type": "Liability"},
    "3000": {"name": "Share Capital",               "type": "Equity"},
    "3100": {"name": "Retained Earnings",           "type": "Equity"},
    "4000": {"name": "Revenue",                     "type": "Revenue"},
    "5000": {"name": "Cost of Sales",               "type": "COGS"},
    "6000": {"name": "Salaries and Wages",          "type": "Expense"},
    "6100": {"name": "Rent Expense",                "type": "Expense"},
    "6200": {"name": "Meals and Entertainment",     "type": "Expense"},
    "6300": {"name": "Office Supplies",             "type": "Expense"},
    "6400": {"name": "Utilities",                   "type": "Expense"},
    "6500": {"name": "Professional / IT Services",  "type": "Expense"},
}


# ── Bedrock system prompt ──────────────────────────────────────────────────
# Designed for prompt caching: large, static, cacheable block.
# The dynamic part (the actual line items) goes in the user message.
# Keep this prompt unchanged between calls — any edit busts the cache.

_CATEGORIZER_SYSTEM = """\
You classify accounting transaction line items against a chart of accounts.
Return ONLY valid JSON. No markdown fences, no explanation, no preamble.

CHART OF ACCOUNTS
1000 Cash (Asset) | 1100 Accounts Receivable (Asset) | 1200 Inventory (Asset)
1500 Fixed Assets (Asset) | 2000 Accounts Payable (Liability) | 2100 Loans Payable (Liability)
3000 Share Capital (Equity) | 3100 Retained Earnings (Equity)
4000 Revenue (Revenue)
5000 Cost of Sales (COGS)
6000 Salaries and Wages (Expense) | 6100 Rent Expense (Expense)
6200 Meals and Entertainment (Expense) | 6300 Office Supplies (Expense)
6400 Utilities (Expense) | 6500 Professional / IT Services (Expense)

CLASSIFICATION RULES
- Cloud hosting, SaaS subscriptions, IT support, consulting, tech services → 6500
- Food, beverages, client dinners, team meals, entertainment → 6200
- Goods purchased for resale, raw materials → 5000
- Office stationery, printer ink/toner, small desk equipment → 6300
- Electricity, water, internet bills → 6400
- Staff wages, salaries, payroll, allowances → 6000
- Office or warehouse rent, lease payments → 6100
- If genuinely ambiguous → choose closest match and set confidence=low

RESPONSE SCHEMA — return exactly this shape, nothing else:
{"classifications": [{"line_no": <int>, "account_code": "<4-digit string>", "confidence": "high"|"low"}]}

EXAMPLES
Input: [{"line_no": 1, "description": "Cloud Server Hosting August 2026"}]
Output: {"classifications": [{"line_no": 1, "account_code": "6500", "confidence": "high"}]}

Input: [{"line_no": 1, "description": "Nasi Lemak Special x10"}, {"line_no": 2, "description": "Monthly Office Rental"}]
Output: {"classifications": [{"line_no": 1, "account_code": "6200", "confidence": "high"}, {"line_no": 2, "account_code": "6100", "confidence": "high"}]}
"""


# ── AWS clients ────────────────────────────────────────────────────────────
# Instantiated at module load so Lambda re-uses the connection across warm invocations.

_bedrock = boto3.client("bedrock-runtime", region_name=REGION)
_dynamo  = boto3.resource("dynamodb",       region_name=REGION)


# ── Decimal helpers ────────────────────────────────────────────────────────

def d(value: Any) -> Decimal:
    """Safe conversion to Decimal, rounded to 2dp. Raises ValueError on bad input."""
    try:
        return Decimal(str(value)).quantize(TWO_PLACES, rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError) as exc:
        raise ValueError(f"Cannot convert {value!r} to Decimal: {exc}") from exc


def ds(value: Decimal) -> str:
    """Decimal → 2dp string for DynamoDB / JSON serialisation."""
    return str(value.quantize(TWO_PLACES))


# ── Bedrock categoriser ────────────────────────────────────────────────────

def categorize_line_items(line_items: list[dict]) -> dict[int, dict]:
    """
    Ask Claude which expense account each line item belongs to.
    Returns {line_no: {"account_code": "NNNN", "confidence": "high"|"low"}}.

    The static system prompt is marked for prompt caching.
    First call is charged at full rate; subsequent calls within the cache TTL
    (~5 min by default on Bedrock) save ~90% on those input tokens.

    Note: if prompt caching is not available on your inference profile, the
    cache_control field is silently ignored — no error, just no discount.
    """
    if not BEDROCK_PROFILE:
        raise RuntimeError(
            "BEDROCK_PROFILE_ID env var is not set.\n"
            "Run: aws bedrock list-inference-profiles --region ap-southeast-1\n"
            "Then set it in the Lambda environment."
        )

    user_content = json.dumps(
        {"line_items": [
            {"line_no": li["line_no"], "description": li.get("description", "")}
            for li in line_items
        ]},
        ensure_ascii=False,
    )

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": MAX_TOKENS,
        # system as an array enables cache_control on the static block
        "system": [
            {
                "type": "text",
                "text": _CATEGORIZER_SYSTEM,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "messages": [{"role": "user", "content": user_content}],
    }

    resp = _bedrock.invoke_model(
        modelId=BEDROCK_PROFILE,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(body),
    )

    raw_text = json.loads(resp["body"].read())["content"][0]["text"].strip()
 
    # Claude sometimes wraps output in markdown fences despite instructions
    # not to. Strip them the same way extraction's code already does.
    if raw_text.startswith("```"):
        raw_text = raw_text.split("```")[1]
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
        raw_text = raw_text.strip()
 
    # parse_float=Decimal is defensive — we don't expect floats in
    # classification output, but this guarantees none sneak through.
    try:
        parsed = json.loads(raw_text, parse_float=Decimal)
    except json.JSONDecodeError as exc:
        # Surface what Claude actually said — a bare "Expecting value" error
        # gives no way to diagnose a bad response without this.
        raise RuntimeError(
            f"Claude's response wasn't valid JSON after fence-stripping: "
            f"{exc}. Raw text (first 300 chars): {raw_text[:300]!r}"
        ) from exc
 
    return {item["line_no"]: item for item in parsed["classifications"]}


# ── Posting rules (pure Python — no LLM touches arithmetic) ───────────────

def post_expense_doc(doc: dict) -> list[dict]:
    """
    Expense-shape document (receipt or invoice) → list of journal entries.

    Posting rule:
      outflow (we paid / received invoice):
        DEBIT  <classified expense/COGS account>
        CREDIT 1000 Cash

      inflow (we issued this invoice, money owed to us):
        DEBIT  1100 Accounts Receivable
        CREDIT 4000 Revenue

    Returns expense-style entries with keys:
      entry_id, date, description, debit_account, credit_account,
      amount (Decimal), confidence, source_doc_id, line_no
    """
    direction  = doc.get("direction", "outflow")
    line_items = doc.get("line_items", [])
    doc_date   = doc.get("document_date") or datetime.now(timezone.utc).date().isoformat()
    doc_id     = doc.get("document_id", "unknown")

    # Categorise only outflow line items — inflow always goes to Revenue.
    if direction == "outflow" and line_items:
        try:
            classifications = categorize_line_items(line_items)
        except Exception as exc:
            logger.warning(
                f"[{doc_id}] Bedrock categorisation failed: {exc}. "
                "Defaulting all lines to 6300 Office Supplies."
            )
            classifications = {}
    else:
        classifications = {}

    entries = []

    for li in line_items:
        line_no = li["line_no"]
        amount  = d(li.get("amount", 0))
        if amount <= 0:
            continue

        if direction == "outflow":
            cls        = classifications.get(line_no, {})
            acct       = cls.get("account_code", "6300")
            confidence = cls.get("confidence", "low")
            if acct not in CHART_OF_ACCOUNTS:
                logger.warning(f"[{doc_id}] LLM returned unknown code {acct!r} → defaulting to 6300")
                acct = "6300"
            debit_account  = acct
            credit_account = "1000"   # Cash
        else:
            # Inflow: we billed a client. Revenue owed to us.
            debit_account  = "1100"   # Accounts Receivable
            credit_account = "4000"   # Revenue
            confidence     = "high"   # no LLM needed

        entries.append({
            "entry_id":       str(uuid.uuid4()),
            "date":           doc_date,
            "description":    li.get("description", ""),
            "debit_account":  debit_account,
            "credit_account": credit_account,
            "amount":         amount,
            "confidence":     confidence,
            "source_doc_id":  doc_id,
            "line_no":        line_no,
        })

    # Post tax as a separate entry if present and non-zero.
    # We don't have a dedicated GST account in this chart, so we use 6500
    # (the most common category for vendor taxes in this context).
    tax = d(doc.get("tax_amount") or 0)
    if tax > 0 and direction == "outflow":
        entries.append({
            "entry_id":       str(uuid.uuid4()),
            "date":           doc_date,
            "description":    f"Tax on {doc.get('reference', doc_id)}",
            "debit_account":  "6500",
            "credit_account": "1000",
            "amount":         tax,
            "confidence":     "high",
            "source_doc_id":  doc_id,
            "line_no":        0,
        })

    return entries


def post_tabular_doc(doc: dict) -> list[dict]:
    """
    Tabular-shape document (trial_balance / ledger already has debit/credit per row).
    Validate account codes against the chart; pass through unchanged.

    Returns tabular-style entries with keys:
      entry_id, date, description, account_code, debit (Decimal),
      credit (Decimal), source_doc_id
    """
    doc_date = (
        doc.get("period", {}).get("end")
        or datetime.now(timezone.utc).date().isoformat()
    )
    doc_id  = doc.get("document_id", "unknown")
    entries = []

    for acct in doc.get("accounts", []):
        if acct.get("is_total"):
            continue  # skip subtotal / grand-total rows

        code = str(acct.get("account_code", "")).strip()
        if code not in CHART_OF_ACCOUNTS:
            logger.warning(f"[{doc_id}] Unknown account code {code!r} — skipping")
            continue

        debit  = d(acct.get("debit",  0))
        credit = d(acct.get("credit", 0))
        if debit == 0 and credit == 0:
            continue

        entries.append({
            "entry_id":     str(uuid.uuid4()),
            "date":         doc_date,
            "description":  acct.get("account_name", ""),
            "account_code": code,
            "debit":        debit,
            "credit":       credit,
            "source_doc_id": doc_id,
        })

    return entries


# ── Trial balance builder ──────────────────────────────────────────────────

def build_trial_balance(entries: list[dict], period: dict) -> dict:
    """
    Aggregate all journal entries into per-account totals.
    
    Plain English: a trial balance is just a summary table — "for each account,
    how much total was debited and how much credited?"  The fundamental invariant
    of double-entry bookkeeping is that the grand total of all debits must equal
    the grand total of all credits.  If it doesn't, a posting is wrong.

    Handles two entry shapes:
      - expense-style: has debit_account / credit_account / amount
      - tabular-style: has account_code / debit / credit

    ALL ARITHMETIC IS HERE.  The LLM never computes a number.
    """
    totals: dict[str, dict[str, Decimal]] = {}

    def add(code: str, dr: Decimal, cr: Decimal) -> None:
        if code not in totals:
            totals[code] = {"debit": Decimal("0"), "credit": Decimal("0")}
        totals[code]["debit"]  += dr
        totals[code]["credit"] += cr

    for e in entries:
        if "debit_account" in e:                    # expense-style
            add(e["debit_account"],  e["amount"],   Decimal("0"))
            add(e["credit_account"], Decimal("0"),  e["amount"])
        elif "account_code" in e:                   # tabular-style
            add(e["account_code"],   e["debit"],    e["credit"])

    rows         = []
    total_debit  = Decimal("0")
    total_credit = Decimal("0")

    for code in sorted(totals):
        info = CHART_OF_ACCOUNTS.get(code, {"name": "Unknown", "type": "Unknown"})
        dr   = totals[code]["debit"].quantize(TWO_PLACES)
        cr   = totals[code]["credit"].quantize(TWO_PLACES)
        net  = (dr - cr).quantize(TWO_PLACES)

        rows.append({
            "account_code": code,
            "account_name": info["name"],
            "account_type": info["type"],
            "debit_total":  ds(dr),
            "credit_total": ds(cr),
            "net_balance":  ds(net),
        })
        total_debit  += dr
        total_credit += cr

    total_debit  = total_debit.quantize(TWO_PLACES)
    total_credit = total_credit.quantize(TWO_PLACES)
    is_balanced  = (total_debit == total_credit)

    if not is_balanced:
        diff = abs(total_debit - total_credit)
        logger.error(
            f"UNBALANCED — Dr={ds(total_debit)} Cr={ds(total_credit)} "
            f"diff={ds(diff)}"
        )

    return {
        "accounts":     rows,
        "total_debit":  ds(total_debit),
        "total_credit": ds(total_credit),
        "is_balanced":  is_balanced,
        "imbalance":    ds(abs(total_debit - total_credit)),
        "period":       period,
    }


# ── DynamoDB persistence ───────────────────────────────────────────────────

def save_to_dynamo(run_id: str, entries: list[dict], trial_balance: dict) -> None:
    """
    Single-table design: all ledger data in one table.

    Key pattern:
      PK = run#{run_id}
      SK = trial_balance             ← one per run (downstream agents query this)
         | entry#{uuid}              ← one per journal line

    Downstream agents read the trial balance like this:
      table.get_item(Key={"PK": f"run#{run_id}", "SK": "trial_balance"})
    """
    table = _dynamo.Table(DYNAMO_TABLE)
    now   = datetime.now(timezone.utc).isoformat()

    # ── Trial balance (single item, queried by all downstream agents) ───
    table.put_item(Item={
        "PK":             f"run#{run_id}",
        "SK":             "trial_balance",
        "item_type":      "trial_balance",
        "run_id":         run_id,
        "created_at":     now,
        "schema_version": SCHEMA_VERSION,
        **trial_balance,
        # trial_balance values are already strings (ds()), so DynamoDB is happy
    })
    logger.info(f"[{run_id}] trial_balance written. balanced={trial_balance['is_balanced']}")

    # ── Journal entries (batch write, 25 at a time) ─────────────────────
    def serialise(entry: dict) -> dict:
        """Decimal → str so DynamoDB doesn't complain about the Python Decimal type."""
        return {k: ds(v) if isinstance(v, Decimal) else v for k, v in entry.items()}

    with table.batch_writer() as batch:
        for e in entries:
            batch.put_item(Item={
                "PK":         f"run#{run_id}",
                "SK":         f"entry#{e['entry_id']}",
                "item_type":  "journal_entry",
                "run_id":     run_id,
                "created_at": now,
                **serialise(e),
            })

    logger.info(f"[{run_id}] {len(entries)} journal entries written")


# ── Lambda handler ─────────────────────────────────────────────────────────

def lambda_handler(event: dict, context) -> dict:
    """
    Accepts either:
      {"run_id": "...", "documents": [{...}, ...]}   ← list of extraction docs
      {"kind": "expense", ...}                        ← single doc (for testing)

    Returns the trial balance JSON (same as what's written to DynamoDB).
    REFUSES to write if the trial balance doesn't balance — downstream agents
    must never receive corrupt numbers.
    """
    logger.info(f"Ledger agent invoked. Event keys: {list(event.keys())}")

    # ── Normalise input ──────────────────────────────────────────────────
    if isinstance(event.get("documents"), list):
        docs   = event["documents"]
        run_id = event.get("run_id") or str(uuid.uuid4())
    elif event.get("kind"):
        docs   = [event]
        run_id = event.get("run_id") or str(uuid.uuid4())
    else:
        return {
            "status":  "error",
            "message": "No documents found. Pass a 'documents' list or a single extraction doc.",
        }

    # ── Process each document ────────────────────────────────────────────
    all_entries: list[dict] = []
    errors:      list[dict] = []
    period = {"start": None, "end": None}

    for doc in docs:
        doc_id = doc.get("document_id", "unknown")
        try:
            kind = doc.get("kind")

            if kind == "expense":
                entries = post_expense_doc(doc)
                doc_date = doc.get("document_date")
                if doc_date:
                    if not period["start"] or doc_date < period["start"]:
                        period["start"] = doc_date
                    if not period["end"] or doc_date > period["end"]:
                        period["end"] = doc_date

            elif kind == "tabular":
                entries = post_tabular_doc(doc)
                tb_period = doc.get("period", {})
                if tb_period.get("start"): period["start"] = tb_period["start"]
                if tb_period.get("end"):   period["end"]   = tb_period["end"]

            else:
                logger.warning(f"[{doc_id}] Unknown kind {kind!r} — skipping")
                errors.append({"document_id": doc_id, "error": f"Unknown kind: {kind!r}"})
                continue

            all_entries.extend(entries)
            logger.info(f"[{doc_id}] → {len(entries)} entries (kind={kind})")

        except Exception as exc:
            logger.error(f"[{doc_id}] Processing failed: {exc}", exc_info=True)
            errors.append({"document_id": doc_id, "error": str(exc)})

    if not all_entries:
        return {
            "status":  "error",
            "run_id":  run_id,
            "message": "No journal entries produced. Check document format and account codes.",
            "errors":  errors,
        }

    # ── Build trial balance (all arithmetic in Python) ───────────────────
    tb = build_trial_balance(all_entries, period)

    # ── Hard stop on imbalance ───────────────────────────────────────────
    # An unbalanced trial balance means a posting rule is wrong.
    # Better to fail loudly here than to produce a P&L / balance sheet
    # that silently lies.
    if not tb["is_balanced"]:
        return {
            "status":        "unbalanced",
            "run_id":        run_id,
            "trial_balance": tb,
            "errors":        errors,
            "message": (
                f"Trial balance does not balance — "
                f"Dr={tb['total_debit']} Cr={tb['total_credit']} "
                f"gap={tb['imbalance']}. "
                "Nothing written to DynamoDB. Fix the posting rules."
            ),
        }

    # ── Persist ───────────────────────────────────────────────────────────
    try:
        save_to_dynamo(run_id, all_entries, tb)
    except ClientError as exc:
        logger.error(f"DynamoDB write failed: {exc}")
        return {
            "status":        "dynamo_error",
            "run_id":        run_id,
            "trial_balance": tb,
            "message":       str(exc),
            "errors":        errors,
        }

    # ── Return the output contract ────────────────────────────────────────
    return {
        "status":              "balanced",
        "run_id":              run_id,
        "schema_version":      SCHEMA_VERSION,
        "currency":            docs[0].get("currency", "MYR"),
        "trial_balance":       tb,
        "journal_entry_count": len(all_entries),
        "errors":              errors,
    }
