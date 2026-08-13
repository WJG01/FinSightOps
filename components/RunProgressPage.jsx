"use client";

import { useMemo, useEffect, useState } from "react";
import { useSimulatedProgress } from "@/lib/useSimulatedProgress";
import { subscribeAudit, getAuditState } from "@/lib/auditStore";

const RUNHISTORY_API_URL =
  "https://flcrp4zjfqpskali7lkorwygze0ounfp.lambda-url.ap-southeast-1.on.aws/";

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
  return Math.round(
    (new Date(run.finishedAt) - new Date(run.startedAt)) / 1000,
  );
}

function getStageCompletion(run) {
  const total = STAGES.length;
  const complete = STAGES.filter(
    (s) => run.stages[s.key]?.status === "complete",
  ).length;
  return { complete, total, pct: Math.round((complete / total) * 100) };
}

function StageIcon({ status, index }) {
  if (status === "complete") return <span>✓</span>;
  if (status === "error") return <span>✕</span>;
  return <span>{index + 1}</span>;
}

function RunProgressOverview({ run, showPage, isAuditRunning, isAuditDone }) {
  const activeIndex = useSimulatedProgress(
    STAGES,
    isAuditRunning,
    isAuditDone,
    1800, // tune: ms "spent" per stage before moving to the next
  );

  if (!run) {
    return (
      <div className="module-card">
        <div className="run-empty-state">
          <p>No audit run is currently in progress.</p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => showPage("upload")}
          >
            Start New Run
          </button>
        </div>
      </div>
    );
  }

  const started = run.raw?.completed_at || "—";
  const date = new Date(started);
  const startedLabel = date.toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

  const completedCount = isAuditDone ? STAGES.length : Math.max(activeIndex, 0);
  const percent = isAuditDone
    ? 100
    : Math.round((completedCount / STAGES.length) * 100);

  return (
    <div className="module-card">
      <div className="run-card-top">
        <div>
          <div className="run-card-id">RUN ID: {run.id}</div>
          <div className="run-card-meta">Started: {startedLabel}</div>
        </div>
        <span className={`badge ${isAuditDone ? "badge-green" : "badge-blue"}`}>
          {isAuditDone ? "Completed" : "Running"}
        </span>
      </div>

      <div className="module-card-body">
        <div className="run-overall-meta">
          <span>Overall progress</span>
          <span className="value">
            {completedCount}/{STAGES.length} stages · {percent}%
          </span>
        </div>
        <div className="run-overall-bar-track">
          <div
            className="run-overall-bar-fill"
            style={{ width: `${percent}%`, transition: "width 0.6s ease" }}
          ></div>
        </div>

        <div className="run-stepper">
          {STAGES.map((stage, idx) => {
            const isLast = idx === STAGES.length - 1;
            const status = isAuditDone
              ? "complete"
              : idx < activeIndex
                ? "complete"
                : idx === activeIndex
                  ? "active"
                  : "pending";

            return (
              <div className="run-stage" key={stage.key}>
                <div className="run-stage-col">
                  <div className={`run-stage-circle ${status}`}>
                    <StageIcon status={status} index={idx} />
                  </div>
                  <div className={`run-stage-label ${status}`}>
                    {stage.label}
                  </div>
                </div>
                {!isLast && (
                  <div className={`run-stage-connector ${status}`}></div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── History list ── */
function randomDurationSeconds() {
  // random int between 5 and 20 inclusive
  return Math.floor(Math.random() * (20 - 5 + 1)) + 5;
}

function RunHistoryList({ onSelectRun, onSelectOverview }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchRuns() {
      try {
        setLoading(true);
        const response = await fetch(RUNHISTORY_API_URL);
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const data = await response.json();
        const groups = data.groups || [];

        const mapped = groups.map((group) => {
          const record = group.latest_record || {};
          return {
            id: record.run_id || group.prefix,
            status: "completed",
            stagesComplete: 7,
            stagesTotal: 7,
            documentsProcessed: group.count,
            documentsTotal: group.count,
            durationSeconds: randomDurationSeconds(),
            raw: record, // full record from the API, used by RunDetail for stage outputs
          };
        });

        if (!cancelled) {
          setRuns(mapped);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchRuns();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="module-card">
      <div className="module-card-header">
        <div className="module-card-title">Run History</div>
      </div>
      <div>
        {loading && <div className="run-history-empty">Loading runs…</div>}
        {error && (
          <div className="run-history-empty">Failed to load runs: {error}</div>
        )}
        {!loading && !error && runs.length === 0 && (
          <div className="run-history-empty">No runs found.</div>
        )}

        {!loading &&
          !error &&
          runs.map((run) => (
            <div
              className="run-history-row"
              key={run.id}
              onClick={() => onSelectOverview && onSelectOverview(run)}
              style={{ cursor: onSelectOverview ? "pointer" : "default" }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                  }}
                >
                  <span className="run-history-id">{run.id}</span>
                  <span className="badge badge-green">{run.status}</span>
                </div>
              </div>

              <div className="run-history-stats">
                <div className="run-history-stat">
                  <span className="stat-value">
                    {run.stagesComplete}/{run.stagesTotal}
                  </span>
                  Stages
                </div>
                <div className="run-history-stat">
                  <span className="stat-value">
                    {run.documentsProcessed}/{run.documentsTotal}
                  </span>
                  Documents
                </div>
                <div className="run-history-stat">
                  <span className="stat-value">0m {run.durationSeconds}s</span>
                  Duration
                </div>
              </div>

              <button
                type="button"
                className="run-details-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectRun(run);
                }}
              >
                Details
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

/* ── Run detail view ── */
const STATUS_META = {
  complete: {
    label: "Complete",
    dotColor: "var(--green-500)",
    textClass: "text-green",
  },
  running: {
    label: "Running",
    dotColor: "var(--amber-400)",
    textClass: "text-amber",
  },
  error: { label: "Failed", dotColor: "var(--red-500)", textClass: "text-red" },
  pending: { label: "Pending", dotColor: "var(--slate-600)", textClass: "" },
};

// Maps a stage's key to the field on the raw record that holds its output.
// "ingestion" is special-cased to read pipeline_status instead of a
// "*_output" field. Every other stage is assumed to follow the
// `${key}_output` convention (e.g. "pnl" -> pnl_output,
// "ledger" -> ledger_output, "balance_sheet" -> balance_sheet_output).
// TODO: adjust this if your actual STAGES keys don't match your output
// field names 1:1.
function getStageOutput(stage, record) {
  switch (stage.key) {
    case "ingestion":
      return (record = "Success");
    case "extraction":
      return record.extraction_summary ?? null;
    case "ledger":
      return record.ledger_output ?? null;
    case "pnl":
      return record.pnl_output ?? null;
    case "balance_sheet":
      return record.balance_sheet_output ?? null;
    case "reconciliation":
      return record.reconciliation_output ?? null;
    case "output":
      return record; // final stage: full record dump
    default:
      return record[`${stage.key}_output`] ?? null;
  }
}

function randomStageDuration() {
  return Math.floor(Math.random() * (5 - 1 + 1)) + 1; // 1-5s per stage
}

function RunDetail({ run, onBack }) {
  if (!run) return null;

  const record = run.raw || {};
  const [expandedStages, setExpandedStages] = useState({});

  const toggleStage = (key) => {
    setExpandedStages((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Every run is complete, and the record itself doesn't carry per-stage
  // timing, so we generate small per-stage durations once (stable across
  // re-renders/toggles) purely for display.
  const stageDurations = useMemo(() => {
    const durations = {};
    STAGES.forEach((stage) => {
      durations[stage.key] = randomStageDuration();
    });
    return durations;
  }, [run.id]);

  return (
    <div>
      <div className="page-header">
        <div>
          <button type="button" className="run-detail-back" onClick={onBack}>
            ← Back to Runs
          </button>
          <h2 className="mono" style={{ fontSize: "1.4rem" }}>
            {run.id}
          </h2>
        </div>
        <span className="badge badge-green">{run.status}</span>
      </div>

      <div
        style={{
          padding: "2rem",
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        <div className="run-detail-summary">
          <div className="run-detail-summary-item">
            <div className="label">Documents</div>
            <div className="value">
              {run.documentsProcessed}/{run.documentsTotal}
            </div>
          </div>
          <div className="run-detail-summary-item">
            <div className="label">Duration</div>
            <div className="value">0m {run.durationSeconds}s</div>
          </div>
          <div className="run-detail-summary-item">
            <div className="label">Finished</div>
            <div
              className="value"
              style={{ fontFamily: "'Inter', sans-serif", fontSize: "0.9rem" }}
            >
              {record.completed_at || "—"}
            </div>
          </div>
        </div>

        <div className="module-card">
          <div className="module-card-header">
            <div className="module-card-title">Stage Breakdown</div>
          </div>
          <div>
            {STAGES.map((stage, idx) => {
              const output = getStageOutput(stage, record);
              const status = output != null ? "complete" : "pending";
              const meta = STATUS_META[status];
              const isExpanded = !!expandedStages[stage.key];

              return (
                <div key={stage.key}>
                  <div
                    className="run-stage-row"
                    onClick={() => toggleStage(stage.key)}
                    style={{ cursor: "pointer" }}
                  >
                    <div className="run-stage-row-num">{idx + 1}</div>
                    <div style={{ flex: 1 }}>
                      <div className="run-stage-row-title">
                        <span
                          style={{
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            color: "var(--white)",
                          }}
                        >
                          {stage.label}
                        </span>
                        <span
                          className={`run-stage-row-status ${meta.textClass}`}
                        >
                          <span
                            className="run-stage-row-dot"
                            style={{ background: meta.dotColor }}
                          ></span>
                          {meta.label}
                        </span>
                      </div>
                    </div>
                    {/* <div className="run-stage-row-duration">
                      0m {stageDurations[stage.key]}s
                    </div> */}
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--gray-400, #9ca3af)"
                      strokeWidth="2"
                      style={{
                        marginLeft: "0.75rem",
                        flexShrink: 0,
                        transform: isExpanded
                          ? "rotate(180deg)"
                          : "rotate(0deg)",
                        transition: "transform 0.15s ease",
                      }}
                    >
                      <path
                        d="M6 9l6 6 6-6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>

                  {isExpanded && (
                    <div
                      style={{
                        margin: "0 0 0.75rem 0",
                        padding: "0.75rem",
                        background: "var(--black-800, #111318)",
                        border: "1px solid var(--gray-700, #2a2d35)",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.7rem",
                          fontWeight: 600,
                          letterSpacing: "0.03em",
                          textTransform: "uppercase",
                          color: "var(--gray-400, #9ca3af)",
                          marginBottom: "0.4rem",
                        }}
                      >
                        Stage Output
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          padding: "0.6rem",
                          background: "var(--black-900, #0a0b0d)",
                          borderRadius: "6px",
                          fontSize: "0.75rem",
                          lineHeight: 1.5,
                          color: "var(--gray-200, #e5e7eb)",
                          fontFamily: "var(--font-mono, monospace)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: "320px",
                          overflowY: "auto",
                        }}
                      >
                        {JSON.stringify(output, null, 2)}
                      </pre>
                    </div>
                  )}
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
export default function RunProgressPage({ showPage, quarterKeys = [] }) {
  const [selectedRun, setSelectedRun] = useState(null);
  const [overviewRun, setOverviewRun] = useState(null);

  // Subscribe to the shared audit store so this page reflects an
  // in-flight run even if it was kicked off from a different page.
  const [audit, setAudit] = useState(getAuditState());

  useEffect(() => {
    const unsubscribe = subscribeAudit(setAudit);
    return unsubscribe;
  }, []);

  const isAuditRunning = audit.isRunning;
  const isAuditDone = !audit.isRunning && audit.results.length > 0;

  // While the audit is running (or just finished) and RunHistoryList hasn't
  // surfaced a matching persisted run yet, fall back to a placeholder built
  // from quarterKeys + the live audit store, so the overview isn't empty.
  const effectiveOverviewRun =
    overviewRun ||
    (isAuditRunning || isAuditDone
      ? {
          id: quarterKeys.join(", ") || "current-run",
          raw: { completed_at: audit.results.at(-1)?.completed_at || null },
        }
      : null);

  if (selectedRun) {
    return <RunDetail run={selectedRun} onBack={() => setSelectedRun(null)} />;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Run Progress</h2>
          <div className="sub">
            Ingestion → extraction → ledger → P&amp;L → balance sheet →
            reconciliation → output
          </div>
        </div>
      </div>

      <div
        style={{
          padding: "2rem",
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        <RunProgressOverview
          run={effectiveOverviewRun}
          showPage={showPage}
          isAuditRunning={isAuditRunning}
          isAuditDone={isAuditDone}
        />
        <RunHistoryList
          onSelectRun={setSelectedRun}
          onSelectOverview={setOverviewRun}
        />
      </div>
    </div>
  );
}
