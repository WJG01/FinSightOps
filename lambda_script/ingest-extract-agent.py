import base64
import email
import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from email import policy

import boto3

REGION = "ap-southeast-1"

s3 = boto3.client("s3", region_name=REGION)
textract = boto3.client("textract", region_name=REGION)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION)
table = dynamodb.Table("auditai-documents")

BUCKET = "auditai-raw-docs-203475186003-ap-southeast-1-an"

# Sonnet 4.6. Confirm the exact string with:
#   aws bedrock list-inference-profiles --region ap-southeast-1
# The 'global.' prefix is already proven working in this account.
MODEL_ID = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"

SCHEMA_VERSION = "1.1"

# Textract routing. Receipts and invoices have expense semantics; statements,
# ledgers and journals are tables and need AnalyzeDocument instead.
ALLOWED_DOC_TYPES = {"receipt", "invoice", "statement",
                     "trial_balance", "ledger", "journal"}
EXPENSE_TYPES = {"receipt", "invoice"}
TABULAR_TYPES = {"statement", "trial_balance", "ledger", "journal"}

BASE_CURRENCY = "MYR"
CONFIDENCE_THRESHOLD = 80.0

MONEY = Decimal("0.01")     # every amount quantized to exactly 2 places
ZERO = Decimal("0.00")


# ===========================================================================
# Money.  Decimal only, always 2dp, never float.
# ===========================================================================

def to_amount(text) -> Decimal | None:
    """'MYR 3,000.5' -> Decimal('3000.50'). None if not a readable number."""
    if text is None:
        return None
    cleaned = re.sub(r"[^\d.\-]", "", str(text))
    if cleaned in ("", "-", "."):
        return None
    try:
        return Decimal(cleaned).quantize(MONEY, rounding=ROUND_HALF_UP)
    except InvalidOperation:
        return None


def money_str(value: Decimal, currency: str = BASE_CURRENCY) -> str:
    """Display only. Never store this."""
    return f"{currency} {value:,.2f}"


def safe_filename(name: str) -> str:
    """Strip path separators so a filename cannot walk the S3 prefix."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", name.rsplit("/", 1)[-1])[:120]


# ===========================================================================
# Textract  -  routed by document type
# ===========================================================================

SUMMARY_FIELDS_WANTED = {
    "VENDOR_NAME", "TOTAL", "SUBTOTAL", "TAX",
    "INVOICE_RECEIPT_DATE", "INVOICE_RECEIPT_ID", "RECEIVER_NAME",
}


def read_expense(file_bytes: bytes) -> dict:
    """AnalyzeExpense (~$10/1k). Receipts and invoices only."""
    resp = textract.analyze_expense(Document={"Bytes": file_bytes})
    docs = resp.get("ExpenseDocuments") or []
    if not docs:
        return {"summary": {}, "text": "", "min_confidence": 0.0}

    doc = docs[0]
    confidences: list[float] = []
    summary: dict[str, str] = {}

    for field in doc.get("SummaryFields", []):
        ftype = (field.get("Type") or {}).get("Text", "")
        detection = field.get("ValueDetection") or {}
        value, conf = detection.get("Text"), detection.get("Confidence")
        if ftype in SUMMARY_FIELDS_WANTED and value is not None:
            summary[ftype] = value
            if conf is not None:
                confidences.append(float(conf))

    rows: list[str] = []
    for group in doc.get("LineItemGroups", []):
        for item in group.get("LineItems", []):
            parts = []
            for field in item.get("LineItemExpenseFields", []):
                ftype = (field.get("Type") or {}).get("Text", "")
                detection = field.get("ValueDetection") or {}
                value, conf = detection.get("Text"), detection.get("Confidence")
                if value is not None:
                    parts.append(f"{ftype}={value}")
                    if conf is not None:
                        confidences.append(float(conf))
            if parts:
                rows.append("  ".join(parts))

    text = "\n".join([f"{k}: {v}" for k, v in summary.items()] + rows)
    return {
        "summary": summary,
        "text": text,
        "min_confidence": min(confidences) if confidences else 0.0,
    }


def read_tables(file_bytes: bytes) -> dict:
    """AnalyzeDocument with TABLES only (~$15/1k). Statements, ledgers,
    journals, trial balances - anything whose meaning lives in a grid.

    Textract's table grid only covers cells inside detected TABLE blocks.
    Page-level text (titles, company name, currency, dates) lives in plain
    LINE blocks outside any table - both need to be captured, or the model
    never sees the header at all.
    """
    resp = textract.analyze_document(
        Document={"Bytes": file_bytes}, FeatureTypes=["TABLES"]
    )
    blocks = {b["Id"]: b for b in resp["Blocks"]}
    confidences: list[float] = []

    header_lines = [
        b["Text"] for b in resp["Blocks"]
        if b["BlockType"] == "LINE" and b.get("Text")
    ]

    def cell_text(cell: dict) -> str:
        words = []
        for rel in cell.get("Relationships", []):
            if rel["Type"] == "CHILD":
                for cid in rel["Ids"]:
                    child = blocks.get(cid, {})
                    if child.get("BlockType") == "WORD":
                        words.append(child["Text"])
        return " ".join(words)

    table_lines: list[str] = []
    for block in resp["Blocks"]:
        if block["BlockType"] != "TABLE":
            continue
        rows: dict[int, dict[int, str]] = {}
        for rel in block.get("Relationships", []):
            if rel["Type"] != "CHILD":
                continue
            for cid in rel["Ids"]:
                cell = blocks.get(cid, {})
                if cell.get("BlockType") != "CELL":
                    continue
                rows.setdefault(cell["RowIndex"], {})[cell["ColumnIndex"]] = cell_text(cell)
                if cell.get("Confidence") is not None:
                    confidences.append(float(cell["Confidence"]))
        for r in sorted(rows):
            table_lines.append(" | ".join(rows[r][c] for c in sorted(rows[r])))
        table_lines.append("")

    text = "\n".join(header_lines) + "\n\n" + "\n".join(table_lines)
    return {
        "summary": {},
        "text": text,
        "min_confidence": min(confidences) if confidences else 0.0,
    }


def read_document(file_bytes: bytes, doc_type: str) -> dict:
    """Right API for the right document. Both return the same shape."""
    if doc_type in EXPENSE_TYPES:
        return read_expense(file_bytes)
    return read_tables(file_bytes)


# ===========================================================================
# Claude  -  mapping and judgment only. No categorisation, no arithmetic.
# ===========================================================================

EXTRACTION_SYSTEM = """You normalise OCR output from financial documents onto a fixed JSON schema.

HARD RULES
- Reply with a single JSON object. No markdown fences, no preamble, no commentary.
- Every monetary value is a NUMBER with exactly two decimal places: 12.50, 5.00,
  3000.00. Never 12.5, never "MYR 12.50", never 1250.
- You NEVER add, subtract, multiply or reconcile any figure. If a line reads
  "40 seats @ $75" with no total shown, its amount is null - do NOT compute
  40 x 75. Python performs every calculation downstream.
- Subtotal, Tax and Total are NOT line items. Put them in their own fields.
  A line item is a good or service being charged for.
- Convert the document date to YYYY-MM-DD. If the printed date is ambiguous,
  set date to null and add "date" to unreadable_fields.
- If a field is simply not on the document, set it to null and do NOT list it
  in unreadable_fields. Many receipts have no "billed to", no separate subtotal
  and no tax line. Absent is not the same as unreadable.
- Only list a field in unreadable_fields if it IS printed but you cannot make
  it out.
- Do not classify, categorise or label the document in any way.

SCHEMA
{
  "vendor": string,
  "billed_to": string or null,
  "date": "YYYY-MM-DD" or null,
  "reference": string or null,
  "currency": "ISO 4217 code, e.g. MYR",
  "line_items": [
    {"description": string, "amount": number or null}
  ],
  "subtotal": number or null,
  "tax": number or null,
  "total": number,
  "unreadable_fields": [string]
}"""


# NOTE: this is deliberately a DIFFERENT schema from EXTRACTION_SYSTEM above.
# A trial balance / ledger / journal has no vendor and no single total - it
# has rows of accounts, each with a debit and a credit.
TABULAR_EXTRACTION_SYSTEM = """You normalise OCR table output from an
accounting document (trial balance, general ledger, journal, or financial
statement) onto a fixed JSON schema.

HARD RULES
- Reply with a single JSON object. No markdown fences, no preamble.
- Every monetary value is a NUMBER with exactly two decimal places.
- You NEVER compute a total, balance, or net figure. If the document shows
  a subtotal or total row, extract it as its own account entry with
  is_total: true - do not calculate it yourself.
- Preserve the account name and account code EXACTLY as printed.
- Each row becomes one entry in "accounts". A row with only a debit has
  credit: 0.00 (not null) and vice versa - do not omit missing side.
- Do not classify, categorise, or reconcile. That is a downstream job.
- If the reporting period is stated, extract start/end as YYYY-MM-DD. If
  only a single year or "as at" date, set start to null and put the single
  date in "end".

SCHEMA
{
  "document_type": "trial_balance" | "ledger" | "journal" | "statement",
  "company": string or null,
  "period": {"start": "YYYY-MM-DD" or null, "end": "YYYY-MM-DD" or null},
  "currency": "ISO 4217 code",
  "accounts": [
    {
      "account_code": string or null,
      "account_name": string,
      "debit": number,
      "credit": number,
      "is_total": boolean
    }
  ],
  "unreadable_fields": [string]
}"""


def normalize_with_claude(ocr_text: str, doc_type: str) -> dict:
    system_prompt = (
        TABULAR_EXTRACTION_SYSTEM if doc_type in TABULAR_TYPES
        else EXTRACTION_SYSTEM
    )
    resp = bedrock.converse(
        modelId=MODEL_ID,
        system=[{"text": system_prompt}],
        messages=[{"role": "user", "content": [{"text": ocr_text}]}],
        inferenceConfig={"maxTokens": 2000, "temperature": 0},
    )
    raw = resp["output"]["message"]["content"][0]["text"].strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    # THE CRITICAL LINE. Without parse_float=Decimal, 12.50 becomes a float
    # here and every later Decimal() call is preserving damage already done.
    return json.loads(raw, parse_float=Decimal)


# ===========================================================================
# Build the contract-shaped document - invoice/receipt shape
# ===========================================================================

def build_document(run_id, doc_type, doc_id, content_hash, s3_key,
                   claude: dict, ocr: dict) -> dict:
    currency = (claude.get("currency") or BASE_CURRENCY).upper()
    review_reasons: list[str] = []

    line_items = []
    for i, raw in enumerate(claude.get("line_items") or [], start=1):
        amount = to_amount(raw.get("amount"))
        if amount is None:
            amount = ZERO
            review_reasons.append(
                f"line {i} ({raw.get('description')!r}) has no readable amount"
            )
        line_items.append({
            "line_no": i,
            "description": raw.get("description", ""),
            "amount": amount,
        })

    stated_total = to_amount(claude.get("total"))
    stated_subtotal = to_amount(claude.get("subtotal"))
    tax = to_amount(claude.get("tax")) or ZERO

    computed_subtotal = sum((li["amount"] for li in line_items), ZERO)
    subtotal = stated_subtotal if stated_subtotal is not None else computed_subtotal
    total = stated_total if stated_total is not None else subtotal + tax

    if stated_subtotal is not None and computed_subtotal != stated_subtotal:
        review_reasons.append(
            f"line items sum to {computed_subtotal} but subtotal reads {stated_subtotal}"
        )
    if subtotal + tax != total:
        review_reasons.append(f"subtotal {subtotal} + tax {tax} != total {total}")

    tex_total = to_amount(ocr["summary"].get("TOTAL"))
    if tex_total is not None and stated_total is not None and tex_total != stated_total:
        review_reasons.append(
            f"Textract read the total as {tex_total}, Claude read {stated_total}"
        )

    if currency != BASE_CURRENCY:
        review_reasons.append(
            f"currency {currency} differs from base {BASE_CURRENCY}; FX conversion required"
        )

    min_conf = ocr["min_confidence"]
    if min_conf and min_conf < CONFIDENCE_THRESHOLD:
        review_reasons.append(f"lowest Textract field confidence {min_conf:.1f}%")

    REQUIRED_FIELDS = {"vendor", "date", "total", "currency"}
    unreadable = claude.get("unreadable_fields") or []
    blocking = [f for f in unreadable if f in REQUIRED_FIELDS]
    if blocking:
        review_reasons.append(f"unreadable required field(s): {', '.join(blocking)}")

    return {
        "kind": "expense",   # lets the handler know which response shape to build
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "doc_type_id": f"{doc_type}#{doc_id}",
        "document_id": f"{doc_type}#{doc_id}",
        "content_hash": f"sha256:{content_hash}",
        "doc_type": doc_type,
        "direction": "inflow" if doc_type == "invoice" else "outflow",
        "status": "pending_review" if review_reasons else "normalized",
        "currency": currency,
        "document_date": claude.get("date"),
        "ingested_at": datetime.now(timezone.utc).isoformat(),
        "vendor": {"name": claude.get("vendor") or ocr["summary"].get("VENDOR_NAME", "")},
        "billed_to": claude.get("billed_to"),
        "reference": claude.get("reference"),
        "line_items": line_items,
        "subtotal": subtotal,
        "tax_amount": tax,
        "total_amount": total,
        "extraction_confidence": {
            "min_field": Decimal(str(round(min_conf, 2))),
            "unreadable_fields": unreadable,
        },
        "review_reasons": review_reasons,
        "raw_textract_ref": s3_key,
    }


# ===========================================================================
# Build the contract-shaped document - accounts (tabular) shape
# ===========================================================================

def build_tabular_document(run_id, doc_type, doc_id, content_hash, s3_key,
                            claude: dict, ocr: dict) -> dict:
    currency = (claude.get("currency") or BASE_CURRENCY).upper()
    review_reasons: list[str] = []

    accounts = []
    total_debit = ZERO
    total_credit = ZERO
    for i, raw in enumerate(claude.get("accounts") or [], start=1):
        debit = to_amount(raw.get("debit")) or ZERO
        credit = to_amount(raw.get("credit")) or ZERO
        is_total = bool(raw.get("is_total"))
        if not is_total:
            total_debit += debit
            total_credit += credit
        accounts.append({
            "line_no": i,
            "account_code": raw.get("account_code"),
            "account_name": raw.get("account_name", ""),
            "debit": debit,
            "credit": credit,
            "is_total": is_total,
        })

    if doc_type in {"trial_balance", "ledger"} and total_debit != total_credit:
        review_reasons.append(
            f"debits ({total_debit}) do not equal credits ({total_credit})"
        )

    min_conf = ocr["min_confidence"]
    if min_conf and min_conf < CONFIDENCE_THRESHOLD:
        review_reasons.append(f"lowest Textract field confidence {min_conf:.1f}%")

    unreadable = claude.get("unreadable_fields") or []

    return {
        "kind": "tabular",   # lets the handler know which response shape to build
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "doc_type_id": f"{doc_type}#{doc_id}",
        "document_id": f"{doc_type}#{doc_id}",
        "content_hash": f"sha256:{content_hash}",
        "doc_type": doc_type,
        "status": "pending_review" if review_reasons else "normalized",
        "currency": currency,
        "period": claude.get("period") or {"start": None, "end": None},
        "ingested_at": datetime.now(timezone.utc).isoformat(),
        "company": claude.get("company"),
        "accounts": accounts,
        "total_debit": total_debit,
        "total_credit": total_credit,
        "extraction_confidence": {
            "min_field": Decimal(str(round(min_conf, 2))),
            "unreadable_fields": unreadable,
        },
        "review_reasons": review_reasons,
        "raw_textract_ref": s3_key,
    }


def to_dynamo(obj):
    """Last line of defence. A float reaching here means a bug upstream -
    fail loudly rather than silently storing an imprecise amount."""
    if isinstance(obj, list):
        return [to_dynamo(x) for x in obj]
    if isinstance(obj, dict):
        return {k: to_dynamo(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, float):
        raise TypeError(
            f"float {obj!r} reached DynamoDB. Money must be Decimal - "
            "check that json.loads used parse_float=Decimal."
        )
    return obj


# ===========================================================================
# Handler
# ===========================================================================

def parse_multipart(body_bytes, content_type):
    msg = email.message_from_bytes(
        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body_bytes,
        policy=policy.default,
    )
    fields = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="Content-Disposition")
        filename = part.get_param("filename", header="Content-Disposition")
        if filename:
            fields[name] = {"filename": filename, "content": part.get_payload(decode=True)}
        else:
            fields[name] = part.get_payload(decode=True).decode().strip()
    return fields


def lambda_handler(event, context):
    content_type = event.get("headers", {}).get("content-type", "")
    if "multipart/form-data" not in content_type:
        return response(400, {"error": "Expected multipart/form-data"})

    raw_body = event["body"]
    body_bytes = base64.b64decode(raw_body) if event.get("isBase64Encoded") else raw_body.encode()

    try:
        fields = parse_multipart(body_bytes, content_type)
        run_id = fields["run_id"]
        doc_type = fields["doc_type"].lower()
        file_part = fields["file"]
        filename = safe_filename(file_part["filename"])
        file_bytes = file_part["content"]
    except KeyError as e:
        return response(400, {"error": f"Missing field: {e}"})

    if doc_type not in ALLOWED_DOC_TYPES:
        return response(400, {
            "error": f'Invalid doc_type "{doc_type}". Must be one of: '
                     f'{", ".join(sorted(ALLOWED_DOC_TYPES))}'
        })

    content_hash = hashlib.sha256(file_bytes).hexdigest()
    doc_id = content_hash[:12]
    s3_key = f"{doc_type}/{run_id}/{doc_id}_{filename}"

    existing = table.get_item(
        Key={"run_id": run_id, "doc_type_id": f"{doc_type}#{doc_id}"}
    ).get("Item")
    upload_count = int(existing.get("upload_count", 1)) + 1 if existing else 1

    s3.put_object(Bucket=BUCKET, Key=s3_key, Body=file_bytes)

    try:
        ocr = read_document(file_bytes, doc_type)
        claude = normalize_with_claude(ocr["text"], doc_type)
        if doc_type in TABULAR_TYPES:
            document = build_tabular_document(
                run_id, doc_type, doc_id, content_hash, s3_key, claude, ocr
            )
        else:
            document = build_document(
                run_id, doc_type, doc_id, content_hash, s3_key, claude, ocr
            )
    except Exception as e:
        table.put_item(Item={
            "run_id": run_id,
            "doc_type_id": f"{doc_type}#{doc_id}",
            "schema_version": SCHEMA_VERSION,
            "status": "failed",
            "error": str(e),
            "content_hash": f"sha256:{content_hash}",
            "raw_textract_ref": s3_key,
            "ingested_at": datetime.now(timezone.utc).isoformat(),
        })
        return response(500, {"error": "Extraction failed", "detail": str(e), "doc_id": doc_id})

    document["upload_count"] = upload_count
    table.put_item(Item=to_dynamo(document))

    # Response shape differs by document kind - an accounts-based document
    # has no single total_amount, an expense-based one has no accounts[].
    if document["kind"] == "tabular":
        out = {
            "doc_id": doc_id,
            "run_id": run_id,
            "status": document["status"],
            "duplicate_upload": upload_count > 1,
            "review_reasons": document["review_reasons"],
            "total_debit": str(document["total_debit"]),
            "total_credit": str(document["total_credit"]),
            "currency": document["currency"],
            "account_count": len(document["accounts"]),
            "s3_key": s3_key,
        }
    else:
        out = {
            "doc_id": doc_id,
            "run_id": run_id,
            "status": document["status"],
            "duplicate_upload": upload_count > 1,
            "review_reasons": document["review_reasons"],
            "total_amount": str(document["total_amount"]),
            "currency": document["currency"],
            "display_total": money_str(document["total_amount"], document["currency"]),
            "s3_key": s3_key,
        }

    return response(200, out)


def response(status_code, body_dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body_dict, default=str),   # default=str handles Decimal
    }
