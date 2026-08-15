"""
recon_agent.py - STAGE 8: RECONCILIATION + TIE-OUT AGENT
FinSight AI Financial Audit System

Lambda   : finsight-reconciliation-tie-out-agent
Region   : ap-southeast-1
Account  : 203475186003
Runtime  : Python 3.12, arm64
Layer    : arn:aws:lambda:ap-southeast-1:856699698935:layer:strands-agents-py3_12-aarch64:2

WHERE THE REASONING MODEL COMES IN
----------------------------------
Exactly one place, and it is deliberately the last place:

    1. Python reads the artifacts                      <- no model
    2. Python computes all 9 checks, in Decimal        <- no model
    3. Python decides PASS or FAIL                     <- no model
    4. Strands + Claude writes the auditor's prose     <- MODEL, here only
    5. Python writes the result to DynamoDB            <- no model

The model never sees a number it is allowed to change. By the time it is
called, every figure is final and verified. Its job is language, not
arithmetic. This is why the agent is trustworthy AND cheap.

COST DESIGN
-----------
  * recon_core.py imports nothing and costs $0 to test locally.
  * PASS  -> one Bedrock call, ZERO tools           ~$0.02
  * FAIL  -> agentic loop with 3 read-only tools    ~$0.08, capped
    You only pay for reasoning when something actually broke.
  * An idempotency lock stops a duplicate trigger paying twice.
  * No prompt caching: one call per run, nothing is reused inside the
    5-minute cache TTL, so it would add complexity for $0 saved.
  * Token usage goes to the log as a structured line, not a CloudWatch
    custom metric (those bill per metric per month).

TWO TABLES - because the pipeline genuinely uses two
----------------------------------------------------
  auditai-ledger      PK=run#{run_id}  SK=trial_balance | pnl |
                                          balance_sheet | cash_ledger |
                                          reconciliation
  auditai-documents   PK=run_id        SK=doc_type_id, e.g. statement#a02ed5
                      (the extraction agent's output, incl. bank statements)
"""

import json
import logging
import os
import time
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from strands import Agent, tool
from strands.models import BedrockModel

import recon_core as core
from recon_core import ZERO, dec

log = logging.getLogger()
log.setLevel(logging.INFO)

REGION = "ap-southeast-1"
LEDGER_TABLE = os.environ.get("LEDGER_TABLE", "auditai-ledger")
DOCS_TABLE = os.environ.get("DOCS_TABLE", "auditai-documents")

# Proven working in this account - taken from the extraction agent, which is
# already calling Bedrock successfully. Do not guess this string.
MODEL_ID = os.environ.get(
    "MODEL_ID", "global.anthropic.claude-sonnet-4-5-20250929-v1:0")

DATE_TOL_DAYS = int(os.environ.get("DATE_TOLERANCE_DAYS", "5"))
MATERIALITY = Decimal(os.environ.get("MATERIALITY", "0.00"))
ENABLE_INVESTIGATION = os.environ.get("ENABLE_INVESTIGATION", "true").lower() == "true"
MAX_TOOL_CALLS = int(os.environ.get("MAX_TOOL_CALLS", "4"))

# A lock older than this is treated as abandoned. It must comfortably exceed
# the Lambda timeout: long enough that a slow-but-alive run is never stolen,
# short enough that a crashed run self-heals without manual cleanup.
LOCK_TTL_SECONDS = int(os.environ.get("LOCK_TTL_SECONDS", "900"))

PRICE_IN = Decimal("3.00")      # USD per 1M input tokens
PRICE_OUT = Decimal("15.00")    # USD per 1M output tokens

_ddb = boto3.resource("dynamodb", region_name=REGION)
_ledger = _ddb.Table(LEDGER_TABLE)
_docs = _ddb.Table(DOCS_TABLE)

REQUIRED = ("trial_balance", "pnl", "balance_sheet")
LOCK_SK = "reconciliation_lock"
OUTPUT_SK = "reconciliation"


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        return str(o) if isinstance(o, Decimal) else super().default(o)


# ------------------------------------------------------------------ reads --

def _pk(run_id):
    return f"run#{run_id}"


def _get(run_id, sk):
    """Read one artifact from the ledger table."""
    return _ledger.get_item(Key={"PK": _pk(run_id), "SK": sk}).get("Item")


def _get_statement(run_id):
    """Find the bank statement in the EXTRACTION agent's table.

    Different table, different key schema: PK=run_id, SK=doc_type_id, where
    doc_type_id looks like 'statement#a02ed51f6dfe'.
    """
    try:
        resp = _docs.query(
            KeyConditionExpression=Key("run_id").eq(run_id)
            & Key("doc_type_id").begins_with("statement#"))
        items = [i for i in resp.get("Items", [])
                 if i.get("status") != "failed"]
        return items[0] if items else None
    except ClientError as exc:
        log.warning("could not query %s for a statement: %s", DOCS_TABLE, exc)
        return None


# ------------------------------------------------------- investigation tools
# Loaded ONLY on the FAIL path. All read-only. None of them do arithmetic.

_tool_budget = {"used": 0}


def _budget_ok():
    _tool_budget["used"] += 1
    return _tool_budget["used"] <= MAX_TOOL_CALLS


@tool
def get_chart_of_accounts(run_id: str) -> str:
    """List every account in the trial balance with its code, name, type and
    balances. Use this first to orient yourself before investigating a
    specific account. All totals are already computed - never recompute them."""
    if not _budget_ok():
        return "Investigation budget exhausted. Write your conclusion now."
    tb = _get(run_id, "trial_balance") or {}
    return json.dumps(tb.get("accounts", []), cls=DecimalEncoder)


@tool
def get_account_postings(run_id: str, account_code: str) -> str:
    """Return the individual journal entries that were posted to one account
    code, so you can see which transactions produced its balance. Use this
    when a tie-out failed and you need to name the entries responsible."""
    if not _budget_ok():
        return "Investigation budget exhausted. Write your conclusion now."
    resp = _ledger.query(
        KeyConditionExpression=Key("PK").eq(_pk(run_id))
        & Key("SK").begins_with("entry#"))
    hits = [e for e in resp.get("Items", [])
            if str(account_code) in (str(e.get("debit_account")),
                                     str(e.get("credit_account")),
                                     str(e.get("account_code")))]
    return json.dumps(hits[:25], cls=DecimalEncoder)


@tool
def get_unmatched_bank_lines(run_id: str) -> str:
    """Return bank statement lines that could not be matched to a cash ledger
    entry. Use this when the bank reconciliation has an unexplained
    difference and you need to describe what is sitting unmatched."""
    if not _budget_ok():
        return "Investigation budget exhausted. Write your conclusion now."
    bank, cash = _load_bank_inputs(run_id)
    if not bank or not cash:
        return "No bank statement or cash ledger is available for this run."
    _, _, un_bank = core.match_lines(cash.get("lines", []),
                                     bank.get("lines", []), DATE_TOL_DAYS)
    return json.dumps([core._clean(i, "unmatched") for i in un_bank],
                      cls=DecimalEncoder)


# ------------------------------------------------------------------ prompts

_RULES = """
Currency is MYR. Every figure you are given was computed and verified in
Python before you were called.

ABSOLUTE RULES:
- Never invent, recompute, re-add or round a number. Quote each figure exactly
  as given, to two decimal places.
- If a check FAILED, say so plainly and name the amount. Do not soften it.
- A reconciling item (an uncleared cheque, a deposit in transit) is NORMAL. It
  is a disclosure, not an error.
- An audit reports what happened. Never propose altering the books to make a
  number agree.
- Prose only. No markdown headings, no bullet lists, no preamble.
"""

NARRATE_PROMPT = """You write the reconciliation section of a financial audit report.

You will receive a JSON object of completed checks. Write 3-4 short paragraphs
covering: whether the statements tie out internally; whether book cash
reconciles to the bank and what explains any difference; any check that was
SKIPPED and why that matters; and a one-line conclusion.
""" + _RULES

INVESTIGATE_PROMPT = """You are the reconciliation auditor. One or more checks
have FAILED.

Use your tools to find out WHY. Look up the accounts, postings or unmatched
lines behind the failure, then write 3-5 paragraphs explaining what broke,
which records are responsible, and what a human reviewer should check first.

Be efficient: call a tool only when it will change what you write. If a tool
says the investigation budget is exhausted, stop and conclude from what you
have.
""" + _RULES


def _model():
    return BedrockModel(model_id=MODEL_ID, region_name=REGION,
                        temperature=0.0, max_tokens=1200, streaming=False)


def _log_cost(result, path):
    """Structured cost line. Query with CloudWatch Logs Insights:
       fields @timestamp, path, in_tokens, out_tokens, est_usd
       | filter cost_log = 1 | sort @timestamp desc
    """
    try:
        usage = result.metrics.accumulated_usage
        tin, tout = int(usage.get("inputTokens", 0)), int(usage.get("outputTokens", 0))
        est = Decimal(tin) / 1_000_000 * PRICE_IN + Decimal(tout) / 1_000_000 * PRICE_OUT
        log.info(json.dumps({"cost_log": 1, "path": path, "in_tokens": tin,
                             "out_tokens": tout,
                             "est_usd": str(est.quantize(Decimal("0.000001")))}))
    except Exception:
        log.warning("token metrics unavailable")


def write_narrative(payload):
    """STEP 4 - the only place the model is used."""
    _tool_budget["used"] = 0
    failed = payload["status"] == "FAIL"
    try:
        if failed and ENABLE_INVESTIGATION:
            agent = Agent(model=_model(), system_prompt=INVESTIGATE_PROMPT,
                          tools=[get_chart_of_accounts, get_account_postings,
                                 get_unmatched_bank_lines])
            path = "investigate"
        else:
            agent = Agent(model=_model(), system_prompt=NARRATE_PROMPT, tools=[])
            path = "narrate"
        result = agent(json.dumps(payload, cls=DecimalEncoder))
        _log_cost(result, path)
        return str(result), path, None
    except Exception as exc:
        log.exception("Strands agent failed; degrading to template narrative")
        return _fallback(payload), "fallback", str(exc)


def _fallback(payload):
    rec = payload["reconciliation"]
    head = ("All tie-out checks passed." if not payload["exceptions"]
            else f"Tie-out FAILED: {', '.join(payload['exceptions'])}.")
    if rec.get("status") == "SKIPPED":
        tail = f"Bank reconciliation skipped: {rec.get('reason', 'inputs absent')}."
    else:
        tail = (f"Book cash of {rec['book_balance']} was reconciled to a bank "
                f"balance of {rec['bank_balance']}, leaving an unexplained "
                f"difference of {rec['unexplained_difference']}.")
    return (f"{head} {tail} Narrative generation was unavailable; every figure "
            f"above was computed and verified in code.")


# --------------------------------------------------------------- bank inputs

def _load_bank_inputs(run_id):
    """Assemble the two independent cash records, if they exist yet.

    cash_ledger : from the ledger agent (NOT BUILT YET - see notes)
    bank        : from the extraction agent's statement document
    """
    cash = _get(run_id, "cash_ledger")
    bank = _get(run_id, "bank_statement")          # hand-seeded shape
    if bank is None:
        doc = _get_statement(run_id)               # real extraction output
        if doc:
            lines, closing, warns = core.statement_doc_to_lines(doc)
            for w in warns:
                log.warning("[%s] statement adapter: %s", run_id, w)
            if closing is not None:
                bank = {"closing_balance": closing, "lines": lines,
                        "source": doc.get("doc_type_id"),
                        "adapter_warnings": warns}
    return bank, cash


# ---------------------------------------------------------------- lock/gate

def _claim_lock(run_id):
    """Wins once per run_id, so a duplicate stream trigger cannot pay Bedrock
    twice. This is a spend control as much as a correctness control.

    A Lambda TIMEOUT does not raise a Python exception - the runtime kills the
    process, so the except branch that releases the lock never runs. A lock
    with no expiry would therefore wedge that run_id permanently after any
    timeout or out-of-memory kill.

    So the lock carries an expires_at, and the condition reclaims it once that
    passes. Do NOT rely on DynamoDB's TTL sweeper for this - it deletes on its
    own schedule, up to 48 hours late. The condition is what makes it correct;
    TTL only tidies up afterwards.
    """
    now = int(time.time())
    try:
        _ledger.put_item(
            Item={"PK": _pk(run_id), "SK": LOCK_SK, "run_id": run_id,
                  "claimed_at": datetime.now(timezone.utc).isoformat(),
                  "expires_at": now + LOCK_TTL_SECONDS},
            ConditionExpression=(
                "attribute_not_exists(PK)"
                " OR attribute_not_exists(expires_at)"   # legacy lock, no expiry
                " OR expires_at < :now"),
            ExpressionAttributeValues={":now": now})
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def _release_lock(run_id):
    _ledger.delete_item(Key={"PK": _pk(run_id), "SK": LOCK_SK})


def run_reconciliation(run_id, force=False):
    # ---- STEP 1: read the artifacts (no model) -------------------------
    artifacts = {sk: _get(run_id, sk) for sk in REQUIRED}
    missing = [sk for sk, v in artifacts.items() if v is None]
    if missing:
        log.info("gate: %s waiting on %s", run_id, missing)
        return {"run_id": run_id, "skipped": True, "waiting_on": missing}

    # A finished run is identified by its RESULT, not by its lock. This is the
    # durable dedup: it survives lock expiry, so a stream re-delivery weeks
    # later still costs nothing.
    if not force:
        done = _get(run_id, OUTPUT_SK)
        if done is not None:
            log.info("gate: %s already completed at %s, returning cached result",
                     run_id, done.get("generated_at"))
            return json.loads(json.dumps(done, cls=DecimalEncoder))

        if not _claim_lock(run_id):
            log.info("gate: %s locked by a run still in flight", run_id)
            return {"run_id": run_id, "skipped": True,
                    "reason": "in_progress",
                    "detail": (f"another invocation claimed this run less than "
                               f"{LOCK_TTL_SECONDS}s ago and has not finished. "
                               f"Retry after it expires, or pass force=true.")}

    try:
        tb, pnl, bs = (artifacts["trial_balance"], artifacts["pnl"],
                       artifacts["balance_sheet"])

        # ---- STEP 2: compute every check in Python (no model) ----------
        tie_outs = core.run_tie_outs(tb, pnl, bs)

        bank, cash = _load_bank_inputs(run_id)
        if bank and cash:
            reconciliation = core.run_bank_reconciliation(
                bs, bank, cash, DATE_TOL_DAYS, MATERIALITY)
            if bank.get("adapter_warnings"):
                reconciliation["adapter_warnings"] = bank["adapter_warnings"]
        else:
            absent = [n for n, v in (("bank statement", bank),
                                     ("cash_ledger", cash)) if not v]
            reconciliation = {
                "name": "bank_vs_book_cash", "status": "SKIPPED",
                "reason": f"missing: {', '.join(absent)}",
                "explanation": (
                    "Reconciliation compares two independent records of the "
                    "same cash. Without both, only the tie-out can run."),
            }

        # ---- STEP 3: decide PASS or FAIL (no model) --------------------
        payload = core.build_result(run_id, tie_outs, reconciliation)
        payload.update({
            "PK": _pk(run_id), "SK": OUTPUT_SK,
            "schema_version": "1.0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "model_id": MODEL_ID,
            "materiality": MATERIALITY,
        })

        # ---- STEP 4: the model writes the prose ------------------------
        narrative, path, err = write_narrative(payload)
        payload["narrative"] = narrative
        payload["narrative_path"] = path
        if err:
            payload["narrative_degraded"] = err

        # ---- STEP 5: persist (no model) --------------------------------
        _ledger.put_item(Item=payload)
        log.info("stage8 %s -> %s (%d exceptions, path=%s)", run_id,
                 payload["status"], len(payload["exceptions"]), path)
        return json.loads(json.dumps(payload, cls=DecimalEncoder))
    except Exception:
        _release_lock(run_id)      # allow a retry after a genuine failure
        raise


# ------------------------------------------------------------------ handler

def _run_ids_from_stream(event):
    ids, watched = [], {"pnl", "balance_sheet"}
    for record in event.get("Records", []):
        if record.get("eventName") not in ("INSERT", "MODIFY"):
            continue
        keys = record.get("dynamodb", {}).get("Keys", {})
        pk = keys.get("PK", {}).get("S", "")
        sk = keys.get("SK", {}).get("S")
        run_id = pk[4:] if pk.startswith("run#") else None
        if run_id and sk in watched and run_id not in ids:
            ids.append(run_id)
    return ids


def lambda_handler(event, context):
    """Accepts a DynamoDB Stream batch, or {"run_id": "...", "force": true}."""
    if "Records" in event:
        run_ids = _run_ids_from_stream(event)
        log.info("stream batch -> candidate runs: %s", run_ids)
        return {"results": [run_reconciliation(r) for r in run_ids]}

    run_id = event.get("run_id") or event.get("runId")
    if not run_id:
        raise ValueError("event needs run_id, or a DynamoDB Records batch")
    return run_reconciliation(run_id, force=bool(event.get("force")))