"use client";

import { useState } from "react";

const STAGES = [
  { key: "ingestion", label: "Ingestion" },
  { key: "extraction", label: "Extraction" },
  { key: "ledger", label: "Ledger" },
  { key: "pnl", label: "P&L" },
  { key: "balance_sheet", label: "Balance Sheet" },
  { key: "reconciliation", label: "Reconciliation" },
  { key: "output", label: "Output" },
];

// Mock data — swap for a real fetch once the backend is wired up.
const MOCK_RUNS = [
  {
    id: "run_20260812_0930",
    startedAt: "2026-08-12T09:30:00Z",
    finishedAt: null,
    status: "running",
    triggeredBy: "Wei Jun",
    documentsProcessed: 34,
    documentsTotal: 50,
    stages: {
      ingestion: { status: "complete", durationSeconds: 12 },
      extraction: { status: "complete", durationSeconds: 48 },
      ledger: { status: "complete", durationSeconds: 21 },
      pnl: { status: "running", durationSeconds: null },
      balance_sheet: { status: "pending", durationSeconds: null },
      reconciliation: { status: "pending", durationSeconds: null },
      output: { status: "pending", durationSeconds: null },
    },
  },
  {
    id: "run_20260805_1402",
    startedAt: "2026-08-05T14:02:00Z",
    finishedAt: "2026-08-05T14:16:44Z",
    status: "completed",
    triggeredBy: "Wei Jun",
    documentsProcessed: 50,
    documentsTotal: 50,
    stages: {
      ingestion: { status: "complete", durationSeconds: 14 },
      extraction: { status: "complete", durationSeconds: 51 },
      ledger: { status: "complete", durationSeconds: 19 },
      pnl: { status: "complete", durationSeconds: 63 },
      balance_sheet: { status: "complete", durationSeconds: 27 },
      reconciliation: { status: "complete", durationSeconds: 88 },
      output: { status: "complete", durationSeconds: 9 },
    },
  },
  {
    id: "run_20260729_0915",
    startedAt: "2026-07-29T09:15:00Z",
    finishedAt: "2026-07-29T09:23:10Z",
    status: "failed",
    triggeredBy: "Auto-schedule",
    documentsProcessed: 41,
    documentsTotal: 50,
    stages: {
      ingestion: { status: "complete", durationSeconds: 13 },
      extraction: { status: "complete", durationSeconds: 46 },
      ledger: { status: "complete", durationSeconds: 20 },
      pnl: { status: "complete", durationSeconds: 58 },
      balance_sheet: {
        status: "error",
        durationSeconds: 31,
        errorMessage:
          "Accounting identity check failed: Assets did not equal Liabilities + Equity within tolerance ($4,120 gap).",
      },
      reconciliation: { status: "pending", durationSeconds: null },
      output: { status: "pending", durationSeconds: null },
    },
  },
  {
    id: "run_20260722_0930",
    startedAt: "2026-07-22T09:30:00Z",
    finishedAt: "2026-07-22T09:41:52Z",
    status: "completed",
    triggeredBy: "Auto-schedule",
    documentsProcessed: 47,
    documentsTotal: 47,
    stages: {
      ingestion: { status: "complete", durationSeconds: 11 },
      extraction: { status: "complete", durationSeconds: 44 },
      ledger: { status: "complete", durationSeconds: 18 },
      pnl: { status: "complete", durationSeconds: 55 },
      balance_sheet: { status: "complete", durationSeconds: 24 },
      reconciliation: { status: "complete", durationSeconds: 79 },
      output: { status: "complete", durationSeconds: 8 },
    },
  },
];

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatTimestamp(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function totalRunDurationSeconds(run) {
  if (!run.finishedAt) return null;
  return Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000);
}

function getStageCompletion(run) {
  const total = STAGES.length;
  const complete = STAGES.filter((s) => run.stages[s.key]?.status === "complete").length;
  return { complete, total, pct: Math.round((complete / total) * 100) };
}

function StageIcon({ status, index }) {
  if (status === "complete") return <span>✓</span>;
  if (status === "error") return <span>✕</span>;
  return <span>{index + 1}</span>;
}

/* ── Current run: overall bar + stepper ── */
function RunProgressOverview({ run }) {
  if (!run) {
    return (
      <div className="module-card">
        <div className="run-empty-state">
          <p>No audit run is currently in progress.</p>
          <button type="button" className="btn-primary">
            Start New Run
          </button>
        </div>
      </div>
    );
  }

  const { complete, total, pct } = getStageCompletion(run);
  const hasError = STAGES.some((s) => run.stages[s.key]?.status === "error");
  const errorStage = Object.values(run.stages).find((s) => s.status === "error");

  return (
    <div className="module-card">
      <div className="run-card-top">
        <div>
          <div className="run-card-id">{run.id}</div>
          <div className="run-card-meta">
            Started {formatTimestamp(run.startedAt)} · {run.documentsProcessed}/{run.documentsTotal} documents
          </div>
        </div>
        <span className={`badge ${run.status === "running" ? "badge-amber" : hasError ? "badge-red" : "badge-green"}`}>
          {run.status === "running" ? "Running" : hasError ? "Failed" : "Completed"}
        </span>
      </div>

      <div className="module-card-body">
        <div className="run-overall-meta">
          <span>Overall progress</span>
          <span className="value">
            {complete}/{total} stages · {pct}%
          </span>
        </div>
        <div className="run-overall-bar-track">
          <div className={`run-overall-bar-fill ${hasError ? "error" : ""}`} style={{ width: `${pct}%` }}></div>
        </div>

        <div className="run-stepper">
          {STAGES.map((stage, idx) => {
            const stageData = run.stages[stage.key] || { status: "pending" };
            const isLast = idx === STAGES.length - 1;
            return (
              <div className="run-stage" key={stage.key}>
                <div className="run-stage-col">
                  <div className={`run-stage-circle ${stageData.status}`}>
                    <StageIcon status={stageData.status} index={idx} />
                  </div>
                  <div className={`run-stage-label ${stageData.status}`}>{stage.label}</div>
                  <div className="run-stage-duration">{formatDuration(stageData.durationSeconds)}</div>
                </div>
                {!isLast && <div className={`run-stage-connector ${stageData.status === "complete" ? "complete" : ""}`}></div>}
              </div>
            );
          })}
        </div>

        {hasError && errorStage?.errorMessage && (
          <div className="run-error-banner">{errorStage.errorMessage}</div>
        )}
      </div>
    </div>
  );
}

/* ── History list ── */
function RunHistoryList({ onSelectRun }) {
  return (
    <div className="module-card">
      <div className="module-card-header">
        <div className="module-card-title">Run History</div>
      </div>
      <div>
        {MOCK_RUNS.map((run) => {
          const { complete, total } = getStageCompletion(run);
          const durationSeconds = totalRunDurationSeconds(run);
          const badgeClass =
            run.status === "running" ? "badge-amber" : run.status === "failed" ? "badge-red" : "badge-green";

          return (
            <div className="run-history-row" key={run.id}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <span className="run-history-id">{run.id}</span>
                  <span className={`badge ${badgeClass}`}>{run.status}</span>
                </div>
                <div className="run-history-sub">
                  {formatTimestamp(run.startedAt)} · Triggered by {run.triggeredBy}
                </div>
              </div>

              <div className="run-history-stats">
                <div className="run-history-stat">
                  <span className="stat-value">{complete}/{total}</span>
                  Stages
                </div>
                <div className="run-history-stat">
                  <span className="stat-value">{run.documentsProcessed}/{run.documentsTotal}</span>
                  Documents
                </div>
                <div className="run-history-stat">
                  <span className="stat-value">{run.status === "running" ? "—" : formatDuration(durationSeconds)}</span>
                  Duration
                </div>
              </div>

              <button type="button" className="run-details-btn" onClick={() => onSelectRun(run.id)}>
                Details
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Run detail view ── */
const STATUS_META = {
  complete: { label: "Complete", dotColor: "var(--green-500)", textClass: "text-green" },
  running: { label: "Running", dotColor: "var(--amber-400)", textClass: "text-amber" },
  error: { label: "Failed", dotColor: "var(--red-500)", textClass: "text-red" },
  pending: { label: "Pending", dotColor: "var(--slate-600)", textClass: "" },
};

function RunDetail({ runId, onBack }) {
  const run = MOCK_RUNS.find((r) => r.id === runId);
  if (!run) return null;

  const durationSeconds = totalRunDurationSeconds(run);
  const badgeClass = run.status === "running" ? "badge-amber" : run.status === "failed" ? "badge-red" : "badge-green";

  return (
    <div>
      <div className="page-header">
        <div>
          <button type="button" className="run-detail-back" onClick={onBack}>
            ← Back to Runs
          </button>
          <h2 className="mono" style={{ fontSize: "1.4rem" }}>{run.id}</h2>
          <div className="sub">Started {formatTimestamp(run.startedAt)} · Triggered by {run.triggeredBy}</div>
        </div>
        <span className={`badge ${badgeClass}`}>{run.status}</span>
      </div>

      <div style={{ padding: "2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <div className="run-detail-summary">
          <div className="run-detail-summary-item">
            <div className="label">Documents</div>
            <div className="value">{run.documentsProcessed}/{run.documentsTotal}</div>
          </div>
          <div className="run-detail-summary-item">
            <div className="label">Duration</div>
            <div className="value">{run.status === "running" ? "In progress" : formatDuration(durationSeconds)}</div>
          </div>
          <div className="run-detail-summary-item">
            <div className="label">Started</div>
            <div className="value" style={{ fontFamily: "'Inter', sans-serif", fontSize: "0.9rem" }}>
              {formatTimestamp(run.startedAt)}
            </div>
          </div>
          <div className="run-detail-summary-item">
            <div className="label">Finished</div>
            <div className="value" style={{ fontFamily: "'Inter', sans-serif", fontSize: "0.9rem" }}>
              {formatTimestamp(run.finishedAt)}
            </div>
          </div>
        </div>

        <div className="module-card">
          <div className="module-card-header">
            <div className="module-card-title">Stage Breakdown</div>
          </div>
          <div>
            {STAGES.map((stage, idx) => {
              const stageData = run.stages[stage.key] || { status: "pending" };
              const meta = STATUS_META[stageData.status] || STATUS_META.pending;
              return (
                <div className="run-stage-row" key={stage.key}>
                  <div className="run-stage-row-num">{idx + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div className="run-stage-row-title">
                      <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--white)" }}>{stage.label}</span>
                      <span className={`run-stage-row-status ${meta.textClass}`}>
                        <span className="run-stage-row-dot" style={{ background: meta.dotColor }}></span>
                        {meta.label}
                      </span>
                    </div>
                    {stageData.status === "error" && stageData.errorMessage && (
                      <div className="run-error-banner" style={{ marginTop: "0.6rem" }}>
                        {stageData.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="run-stage-row-duration">{formatDuration(stageData.durationSeconds)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Page ── */
export default function RunProgressPage() {
  const [selectedRunId, setSelectedRunId] = useState(null);
  const currentRun = MOCK_RUNS.find((r) => r.status === "running") || null;

  if (selectedRunId) {
    return <RunDetail runId={selectedRunId} onBack={() => setSelectedRunId(null)} />;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Run Progress</h2>
          <div className="sub">Ingestion → extraction → ledger → P&amp;L → balance sheet → reconciliation → output</div>
        </div>
      </div>

      <div style={{ padding: "2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <RunProgressOverview run={currentRun} />
        <RunHistoryList onSelectRun={setSelectedRunId} />
      </div>
    </div>
  );
}
