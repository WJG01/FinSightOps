# FinSightOps

**An Agentic AI Finance & Audit Team on AWS**

A seven-agent, AWS-native pipeline that turns raw receipts and invoices into audited financial statements — with a fraud-detection agent running in parallel and a human in the loop before anything ships.

---

## The Problem

Financial close and audit is slow, manual, and error-prone — and it doesn't scale with the team.

- **Weeks of manual review** — Analysts reconcile P&L, balance sheets and receipts by hand across disconnected files, a multi-day effort every cycle.
- **Errors slip through** — Misclassified entries, foot errors and unbalanced statements are caught late, if at all, creating audit and compliance risk.
- **Fraudulent transactions are hard to spot at volume** — A single planted or anomalous entry can hide in thousands of line items reviewed by eye.
- **Data lives everywhere** — Ledgers and source documents are siloed, so no one has a single, verifiable audit picture.

## Our Solution

Seven specialized agents — a virtual audit team — turn a stack of receipts and invoices into a reconciled set of financial statements, with an advisory fraud check running alongside the numbers, not blocking them.

**The Agent Team**

| Agent | Function |
|---|---|
| Extraction | OCR + LLM turn receipts/invoices into structured, verified line items |
| Ledger | Double-entry bookkeeping → trial balance (debits must equal credits) |
| Detection | Advisory-only anomaly/fraud flags off the trial balance — never gates or filters a transaction |
| P&L | Revenue − costs → net income |
| Balance Sheet | Assets = Liabilities + Equity, using P&L's net income |
| Reconciliation + Tie-out | Checks records agree and statements are internally consistent — the heaviest reasoning agent |
| Report Generator | Narrative report to PDF, folding in the trial balance, both statements, reconciliation, and Detection's findings |

**How It Works**

1. **Ingest** — A document lands in S3; Textract `AnalyzeExpense` extracts every figure.
2. **Extract & review** — The Extraction agent produces structured JSON; a human reviews before it becomes ledger data.
3. **Post to the ledger** — The Ledger agent posts double-entry transactions into a trial balance — nothing is written unless debits equal credits.
4. **Fan out** — From the trial balance, two independent branches run: Detection (advisory fraud/anomaly flags) and P&L → Balance Sheet (the one true ordering constraint in the pipeline: the balance sheet's equity section needs the P&L's net income).
5. **Reconcile** — Both statement branches and Detection's findings rejoin at Reconciliation + Tie-out.
6. **Report & review** — The Report Generator produces the narrative + PDF; a second human review signs off before the dashboard shows it.

### In Plain Terms

1. **Upload** — receipts and invoices
2. **AI team reviews** — every figure extracted, posted, and checked
3. **Findings sorted** — clean statements · flagged exceptions disclosed separately, never used to alter the books
4. **Human approves** — twice: once after extraction, once before the report ships
5. **Report** — dashboard shows statements + any fraud flags

> Weeks of manual review become minutes — with a human approving at both ends and every number traceable back to Python arithmetic, not model guesswork.

## Architecture

```
1  Ingestion (S3 + EventBridge)
        |
2  EXTRACTION AGENT — Textract AnalyzeExpense + Bedrock Sonnet -> contract JSON
        |
3  Human review #1
        |
4  LEDGER AGENT — double-entry -> TRIAL BALANCE
        |
   +----+----+
   |         |
5 DETECTION   6 P&L -> 7 BALANCE SHEET (needs P&L's net income)
   |         |
   +----+----+
        |
8  RECONCILIATION + TIE-OUT AGENT
        |
9  REPORT GENERATOR AGENT — narrative + PDF to S3
        |
10  Human review #2
        |
11  Dashboard
        |
12  Orchestrator — runner Lambda now, Step Functions later
```

**Region & model.** Everything runs in **`ap-southeast-1` (Singapore)**. The reasoning engine is **Claude Sonnet 4.5 or 4.6** — pricing is identical, so it's chosen per agent — invoked through a **cross-Region inference profile** (`global.anthropic.claude-sonnet-4-5...` / `...-4-6...`), never a bare model ID, since newer Claude models aren't directly callable in this region. Claude Sonnet 5 is not available here and is not part of that choice.

**Detection is advisory, by design.** It reads the trial balance, writes only its own findings, and rejoins at the Report Generator. It never filters, excludes, or gates a transaction — an audit reports the numbers as they are and discloses exceptions separately.

**Deterministic math, LLM judgment.** All arithmetic — totals, P&L sums, balance checks — runs in Python. Bedrock Sonnet is used only for categorization, edge cases, and narrative. Money is `Decimal`, two decimal places, never `float`.

## AWS Services & Their Functions

| Service | Function |
|---|---|
| Amazon Bedrock — Claude Sonnet 4.5/4.6 | Reasoning engine in every agent: categorization, edge cases, narrative |
| Amazon Textract — AnalyzeExpense | OCR purpose-built for receipts & invoices |
| Amazon S3 | Document store for uploads and generated report PDFs (`ap-southeast-1`, co-located with Textract) |
| AWS Lambda | Runs every agent's Python code |
| Amazon DynamoDB | Stores the ledger, trial balance, statements, and reconciliation results |
| Amazon API Gateway | HTTP endpoints for the dashboard |
| Amazon Cognito | Auth for both human-review steps and the dashboard |
| Amazon CloudWatch | Logs + Bedrock TPM/RPM quota alarms (throttling is a demo-killer) |
| AWS IAM + KMS | Least-privilege access, including the inference-profile ARN grant; encryption at rest |
| Amazon SNS | Alerts when Detection flags something |
| Amazon EventBridge / S3 Events | Triggers the pipeline on upload |
| AWS Step Functions *(later)* | True orchestrator — parallel Detection / P&L↔Balance Sheet branches, replacing the sequential runner Lambda |

A single runner Lambda walks the pipeline sequentially for the hackathon; the fan-out/merge shape above is the *dependency* structure Step Functions will implement as true concurrency later.

## Cost Breakdown

Region is `ap-southeast-1`; budget ceiling is **$200**. At hackathon scale (dozens of demo docs, a few hundred dev runs), real spend is single-digit dollars — the table below is illustrative of the two cost drivers, not a hard forecast.

| Service | Price | Notes |
|---|---|---|
| Bedrock — Claude Sonnet 4.5/4.6 | $3 / $15 per 1M input/output tokens | Prompt caching (~90% reduction on repeated input) is the biggest lever — every agent's static system prompt + few-shot examples should be cached |
| Textract — AnalyzeExpense | ~$10 / 1,000 pages | Use this API specifically; Forms/Tables cost more and aren't a better fit for invoices |
| S3, Lambda, DynamoDB, API Gateway, Cognito, CloudWatch, IAM/KMS, SNS, EventBridge | ~$0 at this volume | Free tier covers hackathon-scale usage |

**Guardrails:** billing alarms at $50/$100/$150; CloudWatch alarms on Bedrock TPM/RPM at 70–80% quota; 7-day log retention; confirm every resource is in `ap-southeast-1` (a bucket in `us-east-1` silently breaks Textract).

## MVP Scope — What We Demo

**In scope**
- The seven-agent pipeline running end-to-end on AWS in `ap-southeast-1`, sequenced by a runner Lambda.
- The core flow: upload → Textract OCR → Extraction → human review #1 → Ledger (trial balance) → Detection ‖ P&L→Balance Sheet → Reconciliation + Tie-out → Report Generator → human review #2 → Dashboard.
- A planted fraud transaction in the sample data set, flagged by Detection and surfaced on the dashboard — the demo's wow moment, decoupled from the statement critical path.

**Deferred to later**
- Step Functions as the true concurrent orchestrator (runner Lambda stands in for now).
- Data masking (Macie/Comprehend), Bedrock Guardrails, managed human review (A2I), a dedicated fraud model (Fraud Detector/SageMaker), and a polished BI dashboard (QuickSight) — named on the roadmap, not built for the hackathon.

**Guardrails held:** AWS-native only (Bedrock, Textract, S3, Lambda, DynamoDB, API Gateway, Cognito, plus the near-free supporting services) · $200 budget · live demo with a recorded fallback · no hardcoded credentials.

## Responsible AI

- **Explainable** — Every number traces back to Python arithmetic; Sonnet's role is limited to categorization and narrative, never silent computation.
- **Advisory, not authoritative** — Detection flags and reports; it never restates or filters the ledger. Exceptions are disclosed alongside the statements, not baked into them.
- **Human-in-the-loop** — Two review gates: after extraction (before data becomes ledger entries) and before the final report ships.

## Roadmap

| Milestone | Focus |
|---|---|
| Now | Seven agents, sequential runner Lambda, single-team demo on AWS |
| Next | Step Functions for true parallel fan-out (Detection ‖ P&L→Balance Sheet) |
| Later | Data masking (Macie/Comprehend), Bedrock Guardrails, managed review (A2I), dedicated fraud model, QuickSight dashboards |

---

**FinSightOps — audit at machine speed, with a human always in command.**
