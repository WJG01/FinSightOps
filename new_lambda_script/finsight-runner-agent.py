"""
runner_agent/handler.py
Runner Lambda — chains the FULL pipeline for one run_id:

  S3 -> Extraction -> [human review gate] -> Ledger -> P&L -> Balance Sheet
  -> Reconciliation

TEMPORARY orchestrator per decisions log 2026-08-06 (Step Functions later).

REVISION (2026-08-10): extended past ledger. Previously this Lambda stopped
after posting to the ledger — P&L/Balance Sheet/Reconciliation had to be
invoked manually afterward. Now a single runner call proves the whole
chain, which is what's needed before wiring up any UI.

Stops and reports clearly at the first failing stage — no point calling
Balance Sheet if P&L never ran, since Balance Sheet's own net_income
lookup would just fail anyway.

Human review gate (between extraction and ledger) is UNCHANGED — still
fires on pending_review. The team's current focus is happy-path documents
only, but extraction's review logic itself was deliberately left untouched
per team decision, so this gate still exists for whenever negative-path
testing resumes.

Two invocation modes:

  1. NEW DOCUMENT (normal path):
     {
       "run_id": "Q4-2026",
       "doc_type": "invoice",
       "bucket": "auditai-raw-docs-203475186003-ap-southeast-1-an",  # optional if UPLOADS_BUCKET env var set
       "s3_key": "manual-uploads/sample_invoice.pdf"
     }

  2. RESUME (after a human approves a pending_review doc — skips
     extraction entirely, goes straight to ledger, then continues through
     P&L/Balance Sheet/Reconciliation same as normal mode):
     {
       "resume": true,
       "run_id": "Q4-2026",
       "doc_type": "invoice",
       "doc_id": "a02ed51f6dfe"
     }

Env vars required:
  EXTRACTION_FUNCTION_NAME     e.g. "finsight-ingest-extract-agent"
  LEDGER_FUNCTION_NAME         e.g. "finsight-ledger-agent"
  PNL_FUNCTION_NAME            e.g. "finsight-pnl-agent"
  BALANCE_SHEET_FUNCTION_NAME  e.g. "finsight-balance-sheet-agent"
  RECONCILIATION_FUNCTION_NAME e.g. "finsight-reconciliation-agent"
  DOCUMENTS_TABLE               default "auditai-documents"
  UPLOADS_BUCKET                default bucket if event doesn't specify "bucket"
"""

import base64
import json
import os
import uuid
import logging
import boto3
from botocore.exceptions import ClientError
from datetime import datetime, timezone
from decimal import Decimal
import uuid



logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

REGION = "ap-southeast-1"

_lambda_client = boto3.client("lambda", region_name=REGION)
_dynamo        = boto3.resource("dynamodb", region_name=REGION)
_s3            = boto3.client("s3", region_name=REGION)

EXTRACTION_FUNCTION_NAME     = os.environ.get("EXTRACTION_FUNCTION_NAME")
LEDGER_FUNCTION_NAME         = os.environ.get("LEDGER_FUNCTION_NAME")
PNL_FUNCTION_NAME            = os.environ.get("PNL_FUNCTION_NAME")
BALANCE_SHEET_FUNCTION_NAME  = os.environ.get("BALANCE_SHEET_FUNCTION_NAME")
RECONCILIATION_FUNCTION_NAME = os.environ.get("RECONCILIATION_FUNCTION_NAME")
DOCUMENTS_TABLE              = os.environ.get("DOCUMENTS_TABLE", "auditai-documents")
DEFAULT_BUCKET               = "upload-bucket-raw"
AUDITAI_OUTPUT_TABLE = "auditai-output"


# ── Step 0: pull the raw file from S3 ──────────────────────────────────────

def fetch_file_from_s3(bucket: str, key: str) -> tuple[bytes, str]:
    """Returns (file_bytes, filename). filename is just the last path segment."""
    try:
        obj = _s3.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        raise RuntimeError(f"Failed to read s3://{bucket}/{key}: {exc}") from exc
    file_bytes = obj["Body"].read()
    filename = key.rsplit("/", 1)[-1]
    return file_bytes, filename


# ── Step 1: build the multipart body extraction expects ───────────────────

def build_multipart_body(run_id: str, doc_type: str, filename: str, file_bytes: bytes) -> tuple[bytes, str]:
    """Hand-builds a multipart/form-data body matching what curl -F produces."""
    boundary = uuid.uuid4().hex
    parts = []

    for field_name, value in (("run_id", run_id), ("doc_type", doc_type)):
        parts.append(f"--{boundary}".encode())
        parts.append(f'Content-Disposition: form-data; name="{field_name}"'.encode())
        parts.append(b"")
        parts.append(str(value).encode())

    parts.append(f"--{boundary}".encode())
    parts.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode())
    parts.append(b"Content-Type: application/octet-stream")
    parts.append(b"")
    parts.append(file_bytes)

    parts.append(f"--{boundary}--".encode())

    body = b"\r\n".join(parts)
    content_type = f"multipart/form-data; boundary={boundary}"
    return body, content_type


# ── Step 2: invoke extraction directly ─────────────────────────────────────

def call_extraction(run_id: str, doc_type: str, filename: str, file_bytes: bytes) -> dict:
    """
    Crafts a minimal event matching what extraction's lambda_handler reads
    (event["headers"]["content-type"], event["body"], event["isBase64Encoded"]).
    Raises RuntimeError on any failure.
    """
    if not EXTRACTION_FUNCTION_NAME:
        raise RuntimeError("EXTRACTION_FUNCTION_NAME env var not set")

    body_bytes, content_type = build_multipart_body(run_id, doc_type, filename, file_bytes)

    crafted_event = {
        "headers": {"content-type": content_type},
        "body": base64.b64encode(body_bytes).decode("ascii"),
        "isBase64Encoded": True,
    }

    logger.info(f"[{run_id}] Invoking extraction: {EXTRACTION_FUNCTION_NAME}")

    try:
        response = _lambda_client.invoke(
            FunctionName=EXTRACTION_FUNCTION_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps(crafted_event).encode("utf-8"),
        )
    except ClientError as exc:
        raise RuntimeError(f"Failed to invoke extraction: {exc}") from exc

    if response.get("FunctionError"):
        raw = response["Payload"].read().decode("utf-8")
        raise RuntimeError(f"Extraction Lambda raised an error: {raw}")

    raw_payload = response["Payload"].read().decode("utf-8")
    top = json.loads(raw_payload)

    status_code = top.get("statusCode")
    body_str    = top.get("body", "{}")
    parsed_body = json.loads(body_str)

    if status_code != 200:
        raise RuntimeError(f"Extraction returned HTTP {status_code}: {parsed_body}")

    return parsed_body   # {"doc_id":..., "status":..., "review_reasons":..., ...}


# ── Step 3: read the FULL document back from DynamoDB ─────────────────────

def fetch_full_document(run_id: str, doc_type: str, doc_id: str) -> dict:
    """
    Extraction's HTTP response is only a summary — the full contract-shaped
    document (line_items / accounts, everything ledger needs) lives here.
    """
    table = _dynamo.Table(DOCUMENTS_TABLE)
    doc_type_id = f"{doc_type}#{doc_id}"

    item = table.get_item(Key={"run_id": run_id, "doc_type_id": doc_type_id}).get("Item")
    if not item:
        raise RuntimeError(
            f"No document found in {DOCUMENTS_TABLE} for "
            f"run_id={run_id!r} doc_type_id={doc_type_id!r}"
        )
    return item


# ── Step 4: invoke ledger with the full document ───────────────────────────

def call_ledger(document: dict) -> dict:
    """
    default=str handles the Decimal values that come back from DynamoDB —
    ledger's own d() helper does Decimal(str(value)), so strings are fine.
    """
    if not LEDGER_FUNCTION_NAME:
        raise RuntimeError("LEDGER_FUNCTION_NAME env var not set")

    logger.info(f"Invoking ledger: {LEDGER_FUNCTION_NAME}")

    try:
        response = _lambda_client.invoke(
            FunctionName=LEDGER_FUNCTION_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps(document, default=str).encode("utf-8"),
        )
    except ClientError as exc:
        raise RuntimeError(f"Failed to invoke ledger: {exc}") from exc

    if response.get("FunctionError"):
        raw = response["Payload"].read().decode("utf-8")
        raise RuntimeError(f"Ledger Lambda raised an error: {raw}")

    raw_payload = response["Payload"].read().decode("utf-8")
    return json.loads(raw_payload)


# ── Step 5: P&L (run-keyed path — returns an HTTP-envelope response) ───────

def call_pnl(run_id: str) -> dict:
    """
    P&L's run-keyed path (added 2026-08-10) still returns via its
    lambda_handler's HTTP-style {"statusCode", "body"} wrapper, same shape
    as extraction's response — unwrap the same way.
    """
    if not PNL_FUNCTION_NAME:
        raise RuntimeError("PNL_FUNCTION_NAME env var not set")

    logger.info(f"[{run_id}] Invoking P&L: {PNL_FUNCTION_NAME}")

    try:
        response = _lambda_client.invoke(
            FunctionName=PNL_FUNCTION_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps({"run_id": run_id}).encode("utf-8"),
        )
    except ClientError as exc:
        raise RuntimeError(f"Failed to invoke P&L: {exc}") from exc

    if response.get("FunctionError"):
        raw = response["Payload"].read().decode("utf-8")
        raise RuntimeError(f"P&L Lambda raised an error: {raw}")

    top = json.loads(response["Payload"].read().decode("utf-8"))
    body = json.loads(top.get("body", "{}"))

    if top.get("statusCode") != 200:
        raise RuntimeError(f"P&L returned HTTP {top.get('statusCode')}: {body}")

    return body   # {"status": "success", "net_income": ..., ...}


# ── Step 6: Balance Sheet (returns a plain dict, no HTTP envelope) ─────────

def call_balance_sheet(run_id: str) -> dict:
    if not BALANCE_SHEET_FUNCTION_NAME:
        raise RuntimeError("BALANCE_SHEET_FUNCTION_NAME env var not set")

    logger.info(f"[{run_id}] Invoking Balance Sheet: {BALANCE_SHEET_FUNCTION_NAME}")

    try:
        response = _lambda_client.invoke(
            FunctionName=BALANCE_SHEET_FUNCTION_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps({"run_id": run_id}).encode("utf-8"),
        )
    except ClientError as exc:
        raise RuntimeError(f"Failed to invoke Balance Sheet: {exc}") from exc

    if response.get("FunctionError"):
        raw = response["Payload"].read().decode("utf-8")
        raise RuntimeError(f"Balance Sheet Lambda raised an error: {raw}")

    return json.loads(response["Payload"].read().decode("utf-8"))


# ── Step 7: Reconciliation (returns a plain dict, no HTTP envelope) ────────

def call_reconciliation(run_id: str) -> dict:
    if not RECONCILIATION_FUNCTION_NAME:
        raise RuntimeError("RECONCILIATION_FUNCTION_NAME env var not set")

    logger.info(f"[{run_id}] Invoking Reconciliation: {RECONCILIATION_FUNCTION_NAME}")

    try:
        response = _lambda_client.invoke(
            FunctionName=RECONCILIATION_FUNCTION_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps({"run_id": run_id}).encode("utf-8"),
        )
    except ClientError as exc:
        raise RuntimeError(f"Failed to invoke Reconciliation: {exc}") from exc

    if response.get("FunctionError"):
        raw = response["Payload"].read().decode("utf-8")
        raise RuntimeError(f"Reconciliation Lambda raised an error: {raw}")

    return json.loads(response["Payload"].read().decode("utf-8"))


# ── Shared: continue the chain after a successful ledger post ──────────────

def continue_after_ledger(run_id: str, ledger_output: dict, extra: dict) -> dict:
    """
    Used by BOTH the normal path and resume mode — a successful ledger post
    continues the same way regardless of how it got there. Stops at the
    first failing stage with a clear pipeline_status naming exactly where.
    """
    if ledger_output.get("status") != "balanced":
        return {
            "pipeline_status": "ledger_failed",
            "run_id": run_id,
            "ledger_output": ledger_output,
            **extra,
        }

    try:
        pnl_output = call_pnl(run_id)
    except RuntimeError as exc:
        logger.error(f"[{run_id}] P&L failed: {exc}")
        return {"pipeline_status": "pnl_failed", "run_id": run_id, "ledger_output": ledger_output, "error": str(exc), **extra}

    if pnl_output.get("status") != "success":
        return {"pipeline_status": "pnl_failed", "run_id": run_id, "ledger_output": ledger_output, "pnl_output": pnl_output, **extra}

    try:
        balance_sheet_output = call_balance_sheet(run_id)
    except RuntimeError as exc:
        logger.error(f"[{run_id}] Balance Sheet failed: {exc}")
        return {"pipeline_status": "balance_sheet_failed", "run_id": run_id, "ledger_output": ledger_output,
                "pnl_output": pnl_output, "error": str(exc), **extra}

    if balance_sheet_output.get("status") != "balanced":
        return {"pipeline_status": "balance_sheet_failed", "run_id": run_id, "ledger_output": ledger_output,
                "pnl_output": pnl_output, "balance_sheet_output": balance_sheet_output, **extra}

    try:
        reconciliation_output = call_reconciliation(run_id)
    except RuntimeError as exc:
        logger.error(f"[{run_id}] Reconciliation failed: {exc}")
        return {"pipeline_status": "reconciliation_failed", "run_id": run_id, "ledger_output": ledger_output,
                "pnl_output": pnl_output, "balance_sheet_output": balance_sheet_output, "error": str(exc), **extra}

    logger.info(f"[{run_id}] Full pipeline complete. Reconciliation status: {reconciliation_output.get('status')}")

    saved_run_id = f"{run_id}_{uuid.uuid4().hex}"


    return save_pipeline_result({
        "pipeline_status": "success",
        "run_id": saved_run_id,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "ledger_output": ledger_output,
        "pnl_output": pnl_output,
        "balance_sheet_output": balance_sheet_output,
        "reconciliation_output": reconciliation_output,
        **extra,
    })

def _convert_floats_to_decimal(obj):
    """Recursively convert all floats in a nested dict/list to Decimal for DynamoDB."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _convert_floats_to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_convert_floats_to_decimal(v) for v in obj]
    return obj

def save_pipeline_result(result: dict) -> dict:
    """
    Persists a pipeline result (as returned by continue_after_ledger) to the
    auditai-output DynamoDB table, keyed by run_id (PK).

    Overwrites any existing item for the same run_id (put_item semantics).
    Raises RuntimeError on failure so callers can decide how to handle it
    (e.g. log-and-continue vs. fail the pipeline).
    """
    run_id = result.get("run_id")
    if not run_id:
        raise ValueError("save_pipeline_result: result is missing 'run_id'")

    table = _dynamo.Table(AUDITAI_OUTPUT_TABLE)
    item = _convert_floats_to_decimal(result)

    try:
        table.put_item(Item=item)
    except ClientError as exc:
        logger.error(f"[{run_id}] Failed to save pipeline result to {AUDITAI_OUTPUT_TABLE}: {exc}")
        raise RuntimeError(f"Failed to persist pipeline result for run_id={run_id}") from exc

    logger.info(f"[{run_id}] Pipeline result saved to {AUDITAI_OUTPUT_TABLE}")
    return result


# ── Handler ─────────────────────────────────────────────────────────────────

def lambda_handler(event: dict, context) -> dict:
    # Lambda Function URLs deliver the actual JSON payload as a STRING inside
    # event["body"] (API Gateway v2 payload format) — not as top-level keys.
    # Direct boto3 invoke() calls (e.g. resume-mode automation) may still pass
    # a flat dict, so only unwrap when "body" is present and is a string.
    if isinstance(event.get("body"), str):
        try:
            parsed_body = json.loads(event["body"]) if event["body"] else {}
            if isinstance(parsed_body, dict):
                event = {**event, **parsed_body}
        except json.JSONDecodeError as exc:
            logger.error(f"Failed to parse event['body'] as JSON: {exc}")
            return {
                "pipeline_status": "error",
                "run_id": event.get("run_id") or str(uuid.uuid4()),
                "error": f"Malformed JSON body: {exc}",
            }

    run_id   = event.get("run_id") or str(uuid.uuid4())
    doc_type = event.get("doc_type")

    if not doc_type:
        return {"pipeline_status": "error", "run_id": run_id, "error": "doc_type is required"}

    # ── RESUME MODE: human already approved this doc — skip straight to ledger ──
    if event.get("resume"):
        doc_id = event.get("doc_id")
        if not doc_id:
            return {"pipeline_status": "error", "run_id": run_id, "error": "doc_id required for resume"}

        logger.info(f"[{run_id}] RESUME mode — skipping extraction. doc_id={doc_id}")
        try:
            full_document = fetch_full_document(run_id, doc_type, doc_id)
            ledger_output = call_ledger(full_document)
        except RuntimeError as exc:
            logger.error(f"[{run_id}] Resume->ledger failed: {exc}")
            return {"pipeline_status": "ledger_failed", "run_id": run_id, "error": str(exc)}

        return continue_after_ledger(run_id, ledger_output, {})

    # ── NORMAL MODE: new document, starts at S3 ─────────────────────────────
    bucket = event.get("bucket") or DEFAULT_BUCKET
    key    = event.get("s3_key") or event.get("key")

    if not bucket or not key:
        return {
            "pipeline_status": "error",
            "run_id": run_id,
            "error": "s3_key required (and bucket, unless UPLOADS_BUCKET env var is set)",
        }

    logger.info(f"[{run_id}] Runner started. doc_type={doc_type} s3://{bucket}/{key}")

    try:
        file_bytes, filename = fetch_file_from_s3(bucket, key)
    except RuntimeError as exc:
        logger.error(f"[{run_id}] S3 fetch failed: {exc}")
        return {"pipeline_status": "s3_fetch_failed", "run_id": run_id, "error": str(exc)}

    # ── Extraction ────────────────────────────────────────────────────────
    try:
        extraction_summary = call_extraction(run_id, doc_type, filename, file_bytes)
    except RuntimeError as exc:
        logger.error(f"[{run_id}] Extraction failed: {exc}")
        return {"pipeline_status": "extraction_failed", "run_id": run_id, "error": str(exc)}

    doc_id = extraction_summary["doc_id"]
    status = extraction_summary.get("status")
    logger.info(f"[{run_id}] Extraction succeeded. doc_id={doc_id} status={status}")

    # ── Human review gate — matches flow spec order (review sits before ledger) ──
    if status == "pending_review":
        logger.warning(
            f"[{run_id}] Document flagged pending_review: "
            f"{extraction_summary.get('review_reasons')}. Stopping before ledger."
        )
        return {
            "pipeline_status": "awaiting_human_review",
            "run_id": run_id,
            "doc_id": doc_id,
            "extraction_summary": extraction_summary,
            "message": (
                "Document needs human review before posting to the ledger. "
                "Approve via the review screen, then re-invoke this Lambda with "
                f'{{"resume": true, "run_id": "{run_id}", "doc_type": "{doc_type}", "doc_id": "{doc_id}"}}'
            ),
        }

    # ── Ledger (only for normalized docs) ───────────────────────────────────
    try:
        full_document = fetch_full_document(run_id, doc_type, doc_id)
        ledger_output = call_ledger(full_document)
    except RuntimeError as exc:
        logger.error(f"[{run_id}] Post-extraction step failed: {exc}")
        return {
            "pipeline_status": "ledger_failed",
            "run_id": run_id,
            "extraction_summary": extraction_summary,
            "error": str(exc),
        }

    logger.info(f"[{run_id}] Ledger status: {ledger_output.get('status')}")

    return continue_after_ledger(run_id, ledger_output, {"extraction_summary": extraction_summary})