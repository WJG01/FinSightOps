// Mock data for audit runs. Swap MOCK_RUNS for a real fetch (API route, DB
// query, etc.) once the backend is wired up — the shape below is what the
// UI components expect back.

export const STAGES = [
  { key: "ingestion", label: "Ingestion" },
  { key: "extraction", label: "Extraction" },
  { key: "ledger", label: "Ledger" },
  { key: "pnl", label: "P&L" },
  { key: "balance_sheet", label: "Balance Sheet" },
  { key: "reconciliation", label: "Reconciliation" },
  { key: "output", label: "Output" },
];

// stage status: "pending" | "running" | "complete" | "error"
export const MOCK_RUNS = [
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
  {
    id: "run_20260715_0930",
    startedAt: "2026-07-15T09:30:00Z",
    finishedAt: "2026-07-15T09:40:03Z",
    status: "completed",
    triggeredBy: "Auto-schedule",
    documentsProcessed: 45,
    documentsTotal: 45,
    stages: {
      ingestion: { status: "complete", durationSeconds: 12 },
      extraction: { status: "complete", durationSeconds: 41 },
      ledger: { status: "complete", durationSeconds: 17 },
      pnl: { status: "complete", durationSeconds: 52 },
      balance_sheet: { status: "complete", durationSeconds: 22 },
      reconciliation: { status: "complete", durationSeconds: 74 },
      output: { status: "complete", durationSeconds: 7 },
    },
  },
];

export function getRunById(runId) {
  return MOCK_RUNS.find((run) => run.id === runId) || null;
}

export function getCurrentRun() {
  return MOCK_RUNS.find((run) => run.status === "running") || null;
}

export function getStageCompletion(run) {
  const total = STAGES.length;
  const complete = STAGES.filter((s) => run.stages[s.key]?.status === "complete").length;
  return { complete, total, pct: Math.round((complete / total) * 100) };
}

export function formatDuration(seconds) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatTimestamp(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function totalRunDurationSeconds(run) {
  if (!run.finishedAt) return null;
  return Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000);
}
