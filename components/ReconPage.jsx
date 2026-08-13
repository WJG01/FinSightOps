import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Reconciliation & Tie-Out page — FinSightOps
 *
 * Talks to API Gateway → Lambda (scan of `auditai-output`):
 *   POST  {endpoint}
 *   body  { "financial_year": "2026", "quarter": "Q4" }
 *
 * The Lambda answers with the latest record for that run_id prefix:
 *   { "statusCode": 200, "body": { ...full run record... } }
 *
 * This page reads ONLY `body.reconciliation_output`. Every other section of
 * the record (pnl_output, ledger_output, balance_sheet_output, …) is ignored.
 *
 * Styling relies on the global FinSightOps stylesheet (.pl-table, .tab-bar,
 * .kpi-row, .finding-item, .badge-*, …). No CSS is imported here.
 */

const DEFAULT_ENDPOINT = "https://j2aac6i6f0.execute-api.ap-southeast-1.amazonaws.com/default/finsight-upload-lookup-agent";

const YEARS = ["2026", "2025", "2024"];
// The Lambda requires a quarter, so there is no "All" option.
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

const TABS = [
  { id: "summary", label: "Summary" },
  { id: "tieouts", label: "Tie-Outs" },
  { id: "exceptions", label: "Exceptions" },
  { id: "narrative", label: "Narrative" },
];

/* ────────────────────────── helpers ────────────────────────── */

const toNumber = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** DynamoDB hands numbers back as strings ("3413.2"), so format defensively. */
const amount = (v, currency) => {
  const n = toNumber(v);
  if (n == null) return v == null || v === "" ? "—" : String(v);
  const body = n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${body}` : body;
};

const WORDS = {
  pnl: "P&L",
  pl: "P&L",
  vs: "vs",
  id: "ID",
  cogs: "COGS",
};

const titleize = (raw) =>
  String(raw ?? "")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const hit = WORDS[w.toLowerCase()];
      if (hit) return hit;
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    })
    .join(" ") || "—";

const STATUS = {
  pass: { tone: "ok", badge: "badge-green", text: "✓ Pass" },
  passed: { tone: "ok", badge: "badge-green", text: "✓ Pass" },
  ok: { tone: "ok", badge: "badge-green", text: "✓ Pass" },
  balanced: { tone: "ok", badge: "badge-green", text: "✓ Balanced" },
  skipped: { tone: "warn", badge: "badge-amber", text: "⊘ Skipped" },
  warn: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  warning: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  review: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  fail: { tone: "alert", badge: "badge-red", text: "✕ Fail" },
  failed: { tone: "alert", badge: "badge-red", text: "✕ Fail" },
  error: { tone: "alert", badge: "badge-red", text: "✕ Fail" },
  exception: { tone: "alert", badge: "badge-red", text: "✕ Exception" },
};

const statusOf = (raw) => STATUS[String(raw ?? "").toLowerCase()] ?? STATUS.warn;

const rowClass = (tone) =>
  tone === "alert" ? "error" : tone === "warn" ? "flagged" : "";

const timestamp = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

/* ────────────────────────── response unwrapping ────────────────────────── */

const tryParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/**
 * Peels the Lambda / API Gateway envelope and returns the DynamoDB record.
 * Handles all three shapes we see in the wild:
 *   { statusCode, body: { … } }            → non-proxy integration
 *   { statusCode, body: "{ … }" }          → proxy integration (stringified)
 *   { … }                                  → mapping template already unwrapped
 * Throws with the Lambda's own message on 400 / 404.
 */
function unwrapRecord(json) {
  let payload = typeof json === "string" ? tryParse(json) : json;

  if (payload && typeof payload === "object" && "body" in payload) {
    const code = Number(payload.statusCode ?? 200);
    const inner =
      typeof payload.body === "string" ? tryParse(payload.body) : payload.body;

    if (code >= 400) {
      throw new Error(
        typeof inner === "string"
          ? inner
          : inner?.message ?? `The audit service returned ${code}.`
      );
    }
    return inner;
  }
  return payload;
}

/* ────────────────────────── normalisation ────────────────────────── */

function normalizeTieOut(raw = {}) {
  const status = statusOf(raw.status);
  const difference = toNumber(raw.difference);

  return {
    key: raw.check ?? raw.name ?? raw.id,
    check: titleize(raw.check ?? raw.name ?? "Unnamed check"),
    leftLabel: raw.left_label ? titleize(raw.left_label) : null,
    left: raw.left,
    rightLabel: raw.right_label ? titleize(raw.right_label) : null,
    right: raw.right,
    difference,
    hasDifference: difference != null,
    // A non-zero difference is always worth calling out, even on a PASS row.
    driftsApart: difference != null && Math.abs(difference) > 0,
    status,
    explanation: raw.explanation ?? "",
    reason: raw.reason ?? "",
  };
}

function normalizeException(raw, index) {
  if (typeof raw === "string") {
    return {
      key: `exception-${index}`,
      title: raw,
      detail: "",
      status: STATUS.fail,
      difference: null,
    };
  }
  const src = raw ?? {};
  return {
    key: src.check ?? src.code ?? `exception-${index}`,
    title: titleize(src.check ?? src.code ?? src.title ?? "Exception"),
    detail: src.explanation ?? src.message ?? src.detail ?? src.reason ?? "",
    status: statusOf(src.status ?? "fail"),
    difference: toNumber(src.difference),
  };
}

/** Reads the reconciliation slice of the run record and nothing else. */
function normalizeReconciliation(record, fallbackCurrency) {
  const recon =
    record?.reconciliation_output ??
    record?.reconciliation ??
    (record?.tie_outs ? record : null);

  if (!recon) {
    throw new Error("This run has no reconciliation_output to display.");
  }

  const tieOuts = (recon.tie_outs ?? []).map(normalizeTieOut);
  const exceptions = (recon.exceptions ?? []).map(normalizeException);

  const cash = recon.reconciliation
    ? {
        name: titleize(recon.reconciliation.name ?? "Cash reconciliation"),
        status: statusOf(recon.reconciliation.status),
        reason: recon.reconciliation.reason ?? "",
        explanation: recon.reconciliation.explanation ?? "",
      }
    : null;

  const counts = tieOuts.reduce(
    (acc, t) => {
      acc[t.status.tone] = (acc[t.status.tone] ?? 0) + 1;
      return acc;
    },
    { ok: 0, warn: 0, alert: 0 }
  );

  const narrative = String(recon.narrative ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    runId: recon.run_id ?? record?.run_id ?? null,
    recordId: record?.run_id ?? null,
    generatedAt: recon.generated_at ?? record?.completed_at ?? null,
    currency: recon.currency ?? fallbackCurrency,
    materiality: toNumber(recon.materiality),
    agent: recon.agent ?? null,
    modelId: recon.model_id ?? null,
    schemaVersion: recon.schema_version ?? null,
    overall: statusOf(recon.status),
    tieOuts,
    exceptions,
    skipped: (recon.skipped ?? []).map(titleize),
    cash,
    counts,
    narrative,
  };
}

/* ────────────────────────── tabs ────────────────────────── */

function SummaryTab({ data }) {
  const cards = [
    { label: "Checks passed", value: data.counts.ok, tone: "ok" },
    { label: "Checks skipped", value: data.counts.warn, tone: "warn" },
    { label: "Checks failed", value: data.counts.alert, tone: "alert" },
    { label: "Exceptions", value: data.exceptions.length, tone: "alert" },
  ];

  return (
    <div style={{ padding: "1.5rem" }}>
      <div className="kpi-row">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`kpi-card ${c.value > 0 && c.tone === "alert" ? "alert" : ""}`}
          >
            <div className="kpi-label">{c.label}</div>
            <div className="kpi-value">{c.value}</div>
          </div>
        ))}
      </div>

      <div className="separator" />

      <div className="section-title">Cash reconciliation</div>
      {data.cash ? (
        <div className={`finding-item ${data.cash.status.tone}`}>
          <span className={`finding-dot ${data.cash.status.tone}`} />
          <div>
            <div className="finding-text">
              <strong>{data.cash.name}</strong> — {data.cash.status.text}
              {data.cash.reason ? ` · ${data.cash.reason}` : ""}
            </div>
            {data.cash.explanation ? (
              <div className="finding-meta">{data.cash.explanation}</div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="empty-state">This run carried no cash reconciliation.</div>
      )}

      <div className="separator" />

      <div className="section-title">What needs attention</div>
      {data.exceptions.length === 0 && data.counts.warn === 0 ? (
        <div className="empty-state">Every tie-out ran and passed.</div>
      ) : (
        <div>
          {data.exceptions.map((e) => (
            <div key={e.key} className={`finding-item ${e.status.tone}`}>
              <span className={`finding-dot ${e.status.tone}`} />
              <div>
                <div className="finding-text">
                  <strong>{e.title}</strong>
                  {e.difference != null
                    ? ` — out by ${amount(e.difference, data.currency)}`
                    : ""}
                </div>
                {e.detail ? <div className="finding-meta">{e.detail}</div> : null}
              </div>
            </div>
          ))}

          {data.tieOuts
            .filter((t) => t.status.tone === "warn")
            .map((t) => (
              <div key={t.key} className="finding-item warn">
                <span className="finding-dot warn" />
                <div>
                  <div className="finding-text">
                    <strong>{t.check}</strong> was skipped.
                  </div>
                  <div className="finding-meta">
                    {t.reason || t.explanation || "No reason supplied."}
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function TieOutsTab({ data }) {
  if (data.tieOuts.length === 0) {
    return <div className="empty-state">This run returned no tie-out checks.</div>;
  }

  return (
    <table className="pl-table">
      <thead>
        <tr>
          <th>Check</th>
          <th style={{ textAlign: "right" }}>Left</th>
          <th style={{ textAlign: "right" }}>Right</th>
          <th style={{ textAlign: "right" }}>Difference</th>
          <th style={{ width: 110 }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {data.tieOuts.map((t) => (
          <tr key={t.key} className={rowClass(t.status.tone)}>
            <td>
              {t.check}
              {t.explanation ? (
                <div className="finding-meta">{t.explanation}</div>
              ) : null}
              {t.reason ? (
                <div className="finding-meta">Skipped: {t.reason}</div>
              ) : null}
            </td>
            <td className="num">
              {t.left == null ? "—" : amount(t.left, data.currency)}
              {t.leftLabel ? <div className="finding-meta">{t.leftLabel}</div> : null}
            </td>
            <td className="num">
              {t.right == null ? "—" : amount(t.right, data.currency)}
              {t.rightLabel ? <div className="finding-meta">{t.rightLabel}</div> : null}
            </td>
            <td className="num">
              <span className={`deviation ${t.driftsApart ? "up" : ""}`}>
                {t.hasDifference ? amount(t.difference, data.currency) : "—"}
              </span>
            </td>
            <td>
              <span className={`badge ${t.status.badge}`}>{t.status.text}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExceptionsTab({ data }) {
  if (data.exceptions.length === 0) {
    return (
      <div className="empty-state">
        No exceptions raised on this run
        {data.skipped.length
          ? ` — though ${data.skipped.length} check${
              data.skipped.length === 1 ? " was" : "s were"
            } skipped.`
          : "."}
      </div>
    );
  }

  return (
    <table className="pl-table">
      <thead>
        <tr>
          <th>Exception</th>
          <th style={{ textAlign: "right" }}>Difference</th>
          <th>Detail</th>
          <th style={{ width: 110 }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {data.exceptions.map((e) => (
          <tr key={e.key} className={rowClass(e.status.tone)}>
            <td>{e.title}</td>
            <td className="num">
              {e.difference == null ? "—" : amount(e.difference, data.currency)}
            </td>
            <td>{e.detail || "No detail supplied by the reconciliation agent."}</td>
            <td>
              <span className={`badge ${e.status.badge}`}>{e.status.text}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NarrativeTab({ data }) {
  if (data.narrative.length === 0) {
    return <div className="empty-state">This run returned no narrative.</div>;
  }
  return (
    <div style={{ padding: "1.5rem", maxWidth: "70ch" }}>
      {data.narrative.map((para, i) => (
        <p key={i} style={{ marginBottom: "1rem", lineHeight: 1.6 }}>
          {para}
        </p>
      ))}
      {data.modelId ? (
        <div className="finding-meta" style={{ marginTop: "1.5rem" }}>
          Written by {data.agent ?? "the reconciliation agent"} · {data.modelId}
        </div>
      ) : null}
    </div>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function Reconciliation({
  endpoint = DEFAULT_ENDPOINT,
  apiKey = "",
  initialYear = "2026",
  initialQuarter = "Q4",
  currency = "MYR",
  autoRun = true,
}) {
  const [year, setYear] = useState(initialYear);
  const [quarter, setQuarter] = useState(initialQuarter);
  const [tab, setTab] = useState("summary");
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  // Display only — the Lambda builds this prefix itself from the two fields.
  const runId = useMemo(() => `${year}-${quarter}`, [year, quarter]);

  const fetchReconciliation = useCallback(
    async (financialYear, qtr) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus("loading");
      setError("");

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { "x-api-key": apiKey } : {}),
          },
          body: JSON.stringify({
            financial_year: financialYear,
            quarter: qtr,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          let detail = "";
          try {
            const body = await res.json();
            detail =
              typeof body === "string"
                ? body
                : body?.body ?? body?.message ?? body?.error ?? "";
          } catch {
            /* non-JSON error body */
          }
          throw new Error(
            (typeof detail === "string" && detail) ||
              `Request failed with status ${res.status}.`
          );
        }

        const record = unwrapRecord(await res.json());
        setData(normalizeReconciliation(record, currency));
        setStatus("ready");
      } catch (err) {
        if (err.name === "AbortError") return;
        setError(err.message || "Could not reach the audit service.");
        setStatus("error");
      }
    },
    [endpoint, apiKey, currency]
  );

  useEffect(() => {
    if (autoRun) fetchReconciliation(initialYear, initialQuarter);
    return () => abortRef.current?.abort();
    // Runs once on mount; later refreshes come from the Run button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const periodLabel = `${quarter} ${year}`;
  const failCount = (data?.counts.alert ?? 0) + (data?.exceptions.length ?? 0);
  const skipCount = data?.counts.warn ?? 0;

  const headerBadge = !data
    ? null
    : failCount > 0
    ? { cls: "badge-red", text: `${failCount} exception${failCount === 1 ? "" : "s"}` }
    : skipCount > 0
    ? { cls: "badge-amber", text: `${skipCount} skipped` }
    : { cls: "badge-green", text: "All checks passed" };

  return (
    <div className="page">
      {/* period filter */}
      <div className="period-filter-bar">
        <div className="period-filter-fields">
          <div className="period-filter-group">
            <label className="period-filter-label" htmlFor="rec-year">
              Financial year
            </label>
            <select
              id="rec-year"
              className="period-filter-select"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          <div className="period-filter-group">
            <label className="period-filter-label" htmlFor="rec-quarter">
              Quarter
            </label>
            <select
              id="rec-quarter"
              className="period-filter-select"
              value={quarter}
              onChange={(e) => setQuarter(e.target.value)}
            >
              {QUARTERS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="button"
          className="btn-primary period-filter-run"
          onClick={() => fetchReconciliation(year, quarter)}
          disabled={status === "loading"}
        >
          {status === "loading" ? "Running…" : "Run"}
        </button>

        <span className="run-card-id">run_id: {runId}</span>
      </div>

      {/* header */}
      <div className="page-header">
        <div>
          <h2>Reconciliation &amp; Tie-Out</h2>
          <div className="sub">
            {periodLabel} · Statement tie-outs, exceptions &amp; auditor narrative
          </div>
        </div>

        {status === "ready" && headerBadge ? (
          <div className="header-actions">
            <span className={`badge ${headerBadge.cls}`}>{headerBadge.text}</span>
          </div>
        ) : null}
      </div>

      {status === "ready" && data && (
        <div className="tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === "exceptions" && data.exceptions.length > 0
                ? ` (${data.exceptions.length})`
                : ""}
            </button>
          ))}
        </div>
      )}

      {/* body */}
      <div className="dashboard-body">
        {status === "loading" && (
          <div className="empty-state">Pulling {runId} from the audit service…</div>
        )}

        {status === "error" && (
          <div className="module-card">
            <div className="module-card-body">
              <div className="run-error-banner">{error}</div>
              <button
                type="button"
                className="btn-ghost"
                style={{ marginTop: "1rem" }}
                onClick={() => fetchReconciliation(year, quarter)}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {status === "idle" && (
          <div className="run-empty-state">
            <p>Pick a period and select Run to load the reconciliation.</p>
          </div>
        )}

        {status === "ready" && data && (
          <div className="module-card">
            <div className="module-card-header">
              <span className="module-card-title">
                {TABS.find((t) => t.id === tab).label} — {periodLabel}
              </span>
              <span className="run-card-id">
                {data.recordId ?? data.runId}
                {data.generatedAt ? ` · ${timestamp(data.generatedAt)}` : ""}
                {data.materiality != null
                  ? ` · materiality ${amount(data.materiality, data.currency)}`
                  : ""}
              </span>
            </div>

            {tab === "summary" && <SummaryTab data={data} />}
            {tab === "tieouts" && <TieOutsTab data={data} />}
            {tab === "exceptions" && <ExceptionsTab data={data} />}
            {tab === "narrative" && <NarrativeTab data={data} />}
          </div>
        )}
      </div>
    </div>
  );
}
