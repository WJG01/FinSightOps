# FinSightOps

**An Agentic AI Finance & Audit Team on AWS**

AWS-native multi-agent auditing, augmented with external MCP integrations.

---

## The Problem

Financial close and audit is slow, manual, and error-prone — and it doesn't scale with the team.

- **Weeks of manual review** — Analysts reconcile P&L, balance sheets and receipts by hand across disconnected files, a multi-day effort every cycle.
- **Errors slip through** — Misclassified entries, foot errors and unbalanced statements are caught late, if at all, creating audit and compliance risk.
- **Duplicate & tampered receipts** — Tampered or resubmitted receipts are near-impossible to spot at volume with the naked eye.
- **Data lives everywhere** — Ledgers, ERP and accounting systems are siloed, so no one has a single, verifiable audit picture.

## Our Solution

A supervisor agent orchestrates four specialist agents — a virtual audit team that reviews every statement in minutes, not weeks.

**The Agent Team**

| Agent | Function |
|---|---|
| P&L Analysis | Margins, trends & anomaly flags |
| Balance Sheet | Assets = Liabilities + Equity checks |
| Receipt Authenticity | Flags duplicate & tampered receipts |
| Reconciliation | Ties receipts to P&L, unifies findings |

**How It Works**

1. **Ingest** — Users upload P&L, balance sheet & receipts. Textract extracts every figure.
2. **Reason** — Supervisor routes work to specialist agents; each pulls its own AWS + MCP tools.
3. **Reconcile** — Findings are cross-checked; flagged items go to a human for approval.

### In Plain Terms

1. **Upload** — P&L, balance sheet, receipts
2. **AI team reviews** — Every figure read & checked
3. **Findings sorted** — Clean pass · risky flagged
4. **Human approves** — Reviewer signs off flagged items
5. **Report** — Dashboard + team notified

> Weeks of manual review become minutes — with a human always approving anything risky.

## Architecture

The system moves a document from upload to approved audit through four layers:

- **Users & web** — CloudFront · Cognito · API Gateway
- **Orchestration** — Amazon Bedrock AgentCore (supervisor agent routes & reconciles)
- **Ingestion** — Amazon S3 · Textract OCR
- **Specialist agents** — P&L · Balance · Receipt · Reconciliation (4 agents)
- **External MCP (via Gateway)** — QuickBooks · SAP · SEC EDGAR · Slack
- **AWS tooling** — Athena · Lambda · DynamoDB
- **Human-in-the-loop & output** — Step Functions · SNS/Slack · QuickSight
- **Security (cross-cutting)** — Secrets Manager · IAM least-privilege · no hardcoded credentials

### Sequence — A Single Audit Run

| Step | Action |
|---|---|
| 1 | Upload docs · Cognito auth |
| 2 | Trigger audit run (S3) |
| 3 | Textract OCR → figures |
| 4 | Route work → agents (parallel) |
| 5 | AWS tools + MCP lookups |
| 6 | Return explainable findings |
| 7 | Reconcile · flagged → human approval |
| 8 | Report + dashboard · Slack alert |

## AWS Services & Their Functions

| Service | Function |
|---|---|
| Bedrock AgentCore | Runtime + Gateway that hosts and orchestrates the agent team |
| Amazon Bedrock (Claude) | Reasoning engine for analysis, explanation & synthesis |
| Amazon Textract | OCR — extracts figures from statements & receipts |
| Amazon S3 | Encrypted document store for all uploaded artifacts |
| Amazon Athena | Queries historical financials for anomaly baselines |
| AWS Lambda | Serverless rules engine for balance-sheet checks |
| Amazon Rekognition + Textract | Duplicate & tamper heuristics: metadata, hashing, vision |
| Amazon DynamoDB | Low-latency cross-checks across the three documents |
| AWS Step Functions | Human-in-the-loop approval workflow for flagged items |
| Amazon QuickSight | Audit dashboards & the final report |
| Amazon SNS | Real-time alerts to reviewers on flagged findings |
| Secrets Manager + IAM | No hardcoded credentials — least-privilege access |

## External MCP Integrations

Agents reach real systems of record through Model Context Protocol servers, surfaced as tools via AgentCore Gateway.

- **QuickBooks / Xero MCP** — Pulls live ledger entries, invoices and expense records so agents audit against the real books, not a stale export.
- **SAP / ERP MCP** — Reads enterprise financial master data and journal entries for org-wide statements and cross-entity reconciliation.
- **Regulatory MCP (SEC EDGAR / tax rules)** — Validates classifications and disclosures against current filing and tax rules for compliance-grade findings.
- **Slack / Teams MCP** — Routes flagged items and approval requests to reviewers in-channel, closing the human-in-the-loop instantly.

**Why MCP:** standardised, credential-scoped tool access means we plug into any system of record without custom glue code — and swap providers without touching the agents.

## Cost Breakdown

Estimated hackathon-MVP spend for one 4-week hack period — serverless & on-demand keep it well under the $100 credit.

| Category | USD |
|---|---|
| Bedrock (Claude) inference | $24.0 |
| Textract OCR | $6.0 |
| Rekognition (tamper + dup checks) | $10.0 |
| QuickSight | $9.0 |
| Athena + DynamoDB | $5.0 |
| AgentCore Runtime | $8.0 |
| Lambda + Step Functions | $2.0 |
| S3 + SNS + Secrets Manager | $3.0 |
| **Estimated total / hack period** | **$67** |

vs. $100 AWS credit · ~33% headroom. External MCP servers run on the vendor side — $0 AWS compute, only minimal egress.

- Serverless (Lambda, Step Functions, on-demand DynamoDB) means we pay only per audit run.
- FinOps guardrails: Bedrock token caps, AgentCore session timeouts, CloudWatch budget alarms.

## MVP Scope — What We Demo

Scoped to what we can build and demo in the hack window — everything else is on the roadmap.

**In scope**
- The agent team: supervisor + specialist agents (P&L, balance sheet, receipt, reconciliation), running end-to-end on AWS.
- The core flow: Upload → Textract OCR → agents reason → Step Functions human approval → SNS/Slack alert + report.
- One live integration: one real MCP connector live (SEC EDGAR or QuickBooks sandbox); remaining systems of record are mocked.

**Deferred to v2**
- Amazon Fraud Detector, full QuickSight seats, and live SAP / ERP — all on the 3-month roadmap.

**Guardrails held:** AWS-native only · $100 credit (est. $67) · team-level impact · live demo · no hardcoded credentials.

## Responsible AI

- **Explainable** — Each agent returns an independent, traceable finding — no black-box verdicts.
- **Governed** — Bedrock Guardrails + full observability on every agent action.
- **Human-in-the-loop** — No flagged item is actioned without human approval via Step Functions.

## Roadmap — v2 in 3 Months

| Milestone | Timeline | Focus |
|---|---|---|
| Now | — | 4 agents, 3 document types, single-team demo on AWS |
| +1 mo | Month 1 | Add cash-flow & tax agents; Fraud Detector, QuickSight seats, connectors (NetSuite, Workday) |
| +2 mo | Month 2 | Continuous audit — auto-trigger on new uploads via S3 events |
| +3 mo | Month 3 | Org-wide rollout with per-entity dashboards and SSO |

---

**FinSightOps — audit at machine speed, with a human always in command.**
