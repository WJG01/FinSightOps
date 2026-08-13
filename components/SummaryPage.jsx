"use client";

/**
 * SummaryPage — every number on this page comes from one call to the
 * FinSight lookup agent. Layout and class names are unchanged.
 *
 *   POST https://.../default/finsight-upload-lookup-agent
 *   body { "financial_year": "2026", "quarter": "Q4" }
 *   200  { statusCode, body: { pnl_output, balance_sheet_output,
 *          ledger_output, reconciliation_output, extraction_summary, ... } }
 *
 * `body` may arrive as an object or as a JSON string — both are handled.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import PeriodSelector, { FINANCIAL_YEARS } from "./PeriodSelector";

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

const API_URL =
  "https://j2aac6i6f0.execute-api.ap-southeast-1.amazonaws.com/default/finsight-upload-lookup-agent";

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

/** Lambda wants "2026" — tolerate "FY2026", "FY26/27", etc. */
const toApiYear = (fy) =>
  (String(fy ?? "").match(/\d{4}/) || [String(fy ?? "")])[0];

/** Lambda wants "Q4" — tolerate "q4", "4", "Quarter 4". */
const toApiQuarter = (q) => {
  const m = String(q ?? "").match(/[1-4]/);
  return m ? `Q${m[0]}` : String(q ?? "").toUpperCase();
};

const isAllQuarters = (q) => String(q ?? "").toLowerCase() === "all";

/**
 * The Lambda returns { statusCode, body }. Depending on whether the route is a
 * proxy integration, `body` arrives as an object or as a JSON string, and the
 * envelope is sometimes unwrapped by the gateway. Handle all three shapes.
 */
function unwrapPayload(raw) {
  let data = raw;

  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error(data.slice(0, 200) || "Empty response from the lookup agent.");
    }
  }

  if (data && typeof data === "object" && "body" in data) {
    let body = data.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* body is a plain message, e.g. the 404 text */
      }
    }
    const code = Number(data.statusCode ?? 200);
    if (code !== 200) {
      throw new Error(
        typeof body === "string" ? body : `Lookup returned ${code}.`
      );
    }
    return body;
  }

  return data;
}

async function fetchRun(financialYear, quarter, signal) {
  const payload = {
    financial_year: toApiYear(financialYear),
    quarter: toApiQuarter(quarter),
  };

  let res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  // If the route is wired for GET only, retry with query params.
  if (!res.ok && [403, 404, 405].includes(res.status)) {
    res = await fetch(`${API_URL}?${new URLSearchParams(payload)}`, { signal });
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Lookup failed (${res.status}). ${text.slice(0, 160)}`);
  }
  return unwrapPayload(text);
}

/** quarter === "all" → fan out across Q1–Q4 and keep the newest run. */
async function fetchPeriod(financialYear, quarter, signal) {
  if (!isAllQuarters(quarter)) {
    return fetchRun(financialYear, quarter, signal);
  }

  const settled = await Promise.allSettled(
    QUARTERS.map((q) => fetchRun(financialYear, q, signal))
  );

  const runs = settled
    .filter(
      (s) => s.status === "fulfilled" && s.value && typeof s.value === "object"
    )
    .map((s) => s.value);

  if (!runs.length) {
    throw new Error(
      `No completed runs found for ${toApiYear(
        financialYear
      )}. Pick a specific quarter, or upload documents and run the pipeline first.`
    );
  }

  return runs.reduce((a, b) =>
    String(b.completed_at ?? "") > String(a.completed_at ?? "") ? b : a
  );
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const toNum = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const money = (v, ccy) =>
  `${ccy ? ccy + " " : ""}${toNum(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const titleise = (s) =>
  String(s ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

function relTime(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

const tone = (v) => (v >= 90 ? "green" : v >= 70 ? "amber" : "red");

/* ------------------------------------------------------------------ *
 * Derive everything the dashboard shows from one run record
 * ------------------------------------------------------------------ */

function deriveAudit(run) {
  const pnl = run?.pnl_output ?? {};
  const bs = run?.balance_sheet_output?.balance_sheet ?? {};
  const ledger = run?.ledger_output ?? {};
  const tb = ledger.trial_balance ?? {};
  const rec = run?.reconciliation_output ?? {};
  const ext = run?.extraction_summary ?? {};

  const currency = ext.currency || ledger.currency || "";
  const runAge = relTime(run?.completed_at);

  const tieOuts = Array.isArray(rec.tie_outs) ? rec.tie_outs : [];
  const passed = tieOuts.filter((t) => t.status === "PASS");
  const failed = tieOuts.filter((t) =>
    ["FAIL", "EXCEPTION", "ERROR"].includes(t.status)
  );
  const skipped = tieOuts.filter((t) => t.status === "SKIPPED");
  const exceptions = Array.isArray(rec.exceptions) ? rec.exceptions : [];
  const reviewReasons = Array.isArray(ext.review_reasons)
    ? ext.review_reasons
    : [];
  const duplicateUpload = Boolean(ext.duplicate_upload);
  const isBalanced =
    bs.is_balanced === true || String(bs.is_balanced) === "true";
  const bankRec = rec.reconciliation ?? {};
  const bankRecSkipped =
    String(bankRec.status ?? "").toUpperCase() === "SKIPPED";

  // The P&L agent and the reconciliation agent must agree on net income.
  // If they don't, the tie-out ran against a different ledger snapshot.
  const pnlCheck = tieOuts.find((t) => t.check === "pnl_arithmetic");
  const recNet = pnlCheck ? toNum(pnlCheck.right) : null;
  const pnlNet = toNum(pnl.net_income);
  const sourceMismatch =
    recNet !== null && Math.abs(recNet - pnlNet) > 0.01
      ? { recNet, pnlNet }
      : null;

  /* ---- score ---- */
  let score = 100;
  score -= failed.length * 15;
  score -= exceptions.length * 10;
  score -= skipped.length * 5;
  score -= bankRecSkipped ? 5 : 0;
  score -= duplicateUpload ? 8 : 0;
  score -= reviewReasons.length * 3;
  score -= isBalanced ? 0 : 20;
  score -= sourceMismatch ? 10 : 0;
  score = clamp(score);

  const scoreChecks = (match) => {
    const subset = tieOuts.filter((t) => match(String(t.check ?? "")));
    if (!subset.length) return null;
    const pts = subset.reduce(
      (a, t) =>
        a + (t.status === "PASS" ? 1 : t.status === "SKIPPED" ? 0.5 : 0),
      0
    );
    return clamp((pts / subset.length) * 100);
  };

  const modules = {
    pl: clamp(
      (scoreChecks((c) => /pnl|revenue|expense|gross_profit/.test(c)) ?? 100) -
        (sourceMismatch ? 20 : 0)
    ),
    balance: clamp(
      (scoreChecks((c) =>
        /balance_sheet|trial_balance|cash|retained/.test(c)
      ) ?? 100) - (isBalanced ? 0 : 40)
    ),
    receipts: clamp(
      100 -
        (duplicateUpload ? 40 : 0) -
        reviewReasons.length * 10 -
        (ext.status && ext.status !== "normalized" ? 20 : 0)
    ),
    recon: clamp(
      (tieOuts.length ? (passed.length / tieOuts.length) * 100 : 100) -
        (bankRecSkipped ? 15 : 0)
    ),
  };

  /* ---- findings ---- */
  const findings = [];

  failed.forEach((t) =>
    findings.push({
      level: "alert",
      title: `${titleise(t.check)} failed`,
      detail: `${titleise(t.left_label)} ${money(
        t.left,
        currency
      )} vs ${titleise(t.right_label)} ${money(t.right, currency)} — off by ${money(
        t.difference,
        currency
      )}.`,
      meta: `RECONCILIATION · Critical · ${runAge}`,
    })
  );

  exceptions.forEach((e) =>
    findings.push({
      level: "alert",
      title: "Reconciliation exception",
      detail:
        typeof e === "string" ? e : e.message || e.detail || JSON.stringify(e),
      meta: `RECONCILIATION · Critical · ${runAge}`,
    })
  );

  if (duplicateUpload) {
    findings.push({
      level: "alert",
      title: "Duplicate document submission",
      detail: `Document ${ext.doc_id ?? "—"} (${
        ext.display_total ?? money(ext.total_amount, currency)
      }) matches a document already ingested for this period. Confirm it is not a re-submitted expense before approving.`,
      meta: `RECEIPTS · Critical · ${runAge}`,
    });
  }

  if (!isBalanced) {
    findings.push({
      level: "alert",
      title: "Balance sheet does not balance",
      detail: `Assets ${money(
        bs.total_assets,
        currency
      )} vs liabilities + equity ${money(
        toNum(bs.total_liabilities) + toNum(bs.total_equity),
        currency
      )} — imbalance ${money(bs.imbalance, currency)}.`,
      meta: `BALANCE SHEET · Critical · ${runAge}`,
    });
  }

  if (sourceMismatch) {
    findings.push({
      level: "warn",
      title: "P&L and reconciliation disagree on net income",
      detail: `The P&L agent reports ${money(
        sourceMismatch.pnlNet,
        currency
      )} but the tie-out was run against ${money(
        sourceMismatch.recNet,
        currency
      )}. The reconciliation is stale — re-run it against the current ledger.`,
      meta: `RECONCILIATION · Warning · ${runAge}`,
    });
  }

  reviewReasons.forEach((r) =>
    findings.push({
      level: "warn",
      title: "Document flagged for review",
      detail: typeof r === "string" ? r : JSON.stringify(r),
      meta: `RECEIPTS · Warning · ${runAge}`,
    })
  );

  skipped.forEach((t) =>
    findings.push({
      level: "warn",
      title: `${titleise(t.check)} could not be checked`,
      detail:
        t.reason || t.explanation || "Required inputs were not available.",
      meta: `RECONCILIATION · Skipped · ${runAge}`,
    })
  );

  if (bankRecSkipped) {
    findings.push({
      level: "warn",
      title: `${titleise(bankRec.name || "Bank reconciliation")} not performed`,
      detail: `${bankRec.reason ?? "Source documents missing."} ${
        bankRec.explanation ?? ""
      }`.trim(),
      meta: `RECONCILIATION · Skipped · ${runAge}`,
    });
  }

  if (isBalanced) {
    findings.push({
      level: "ok",
      title: "Balance sheet identity verified",
      detail: `Assets ${money(bs.total_assets, currency)} = Liabilities ${money(
        bs.total_liabilities,
        currency
      )} + Equity ${money(bs.total_equity, currency)}`,
      meta: `BALANCE SHEET · Passed · ${runAge}`,
    });
  }

  if (tb.is_balanced) {
    findings.push({
      level: "ok",
      title: "Trial balance in balance",
      detail: `Debits ${money(tb.total_debit, currency)} = Credits ${money(
        tb.total_credit,
        currency
      )} across ${(tb.accounts ?? []).length} accounts.`,
      meta: `LEDGER · Passed · ${runAge}`,
    });
  }

  const criticals = findings.filter((f) => f.level === "alert").length;
  const warnings = findings.filter((f) => f.level === "warn").length;

  const revenue = toNum(pnl.total_revenue);
  const netMargin = revenue !== 0 ? (pnlNet / revenue) * 100 : null;

  const matched = passed.length;
  const totalChecks = tieOuts.length;
  const reconciledPct = totalChecks
    ? Math.round((matched / totalChecks) * 100)
    : null;

  return {
    currency,
    runAge,
    score,
    modules,
    findings,
    criticals,
    warnings,
    netMargin,
    isBalanced,
    suspiciousDocs: (duplicateUpload ? 1 : 0) + reviewReasons.length,
    reconciledPct,
    matched,
    totalChecks,
    narrative: rec.narrative ?? "",
    transactionCount: pnl.transaction_count ?? null,
    meta: {
      runId: run?.run_id ?? rec.run_id ?? "—",
      pipeline: run?.pipeline_status ?? "—",
      docId: ext.doc_id ?? "—",
      completedAt: run?.completed_at ?? null,
      model: rec.model_id ?? "—",
    },
  };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export default function SummaryPage({ showPage }) {
  const [financialYear, setFinancialYear] = useState(FINANCIAL_YEARS[0]);
  const [quarter, setQuarter] = useState("all");

  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loadedPeriod, setLoadedPeriod] = useState("");

  const abortRef = useRef(null);

  const load = useCallback(async (fy, q) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);

    try {
      const record = await fetchPeriod(fy, q, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setAudit(deriveAudit(record));
      setLoadedPeriod(
        `${toApiYear(fy)} · ${isAllQuarters(q) ? "Latest quarter" : toApiQuarter(q)}`
      );
    } catch (e) {
      if (e?.name === "AbortError") return;
      setAudit(null);
      setError(
        String(e?.message ?? "").includes("Failed to fetch")
          ? "Can't reach the lookup agent. Check the connection, and confirm CORS is enabled on the API Gateway route."
          : e?.message || "Something went wrong loading this period."
      );
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(financialYear, quarter);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const a = audit;

  return (
    <div>
      <PeriodSelector
        financialYear={financialYear}
        quarter={quarter}
        onFinancialYearChange={setFinancialYear}
        onQuarterChange={setQuarter}
        onRun={() => load(financialYear, quarter)}
      />

      <div className="page-header">
        <div>
          <h2>Summary Dashboard</h2>
          <div className="sub">
            {loading && !a
              ? "Loading run…"
              : a
              ? `${loadedPeriod} · ${a.transactionCount ?? 0} transactions · Last run ${a.runAge}`
              : "No run loaded"}
          </div>
        </div>
        <div className="header-actions">
          {a && a.warnings > 0 && (
            <span className="badge badge-amber">
              {a.warnings} Warning{a.warnings > 1 ? "s" : ""}
            </span>
          )}
          {a && a.criticals > 0 && (
            <span className="badge badge-red">{a.criticals} Critical</span>
          )}
          <button
            className="btn-primary"
            disabled={!a || loading}
            onClick={() => showPage?.("recon")}
          >
            Generate Summary Report
          </button>
        </div>
      </div>

      {error && (
        <div
          className="module-card"
          style={{ margin: "0 0 1.5rem", borderColor: "var(--red-500, #ef4444)" }}
        >
          <div className="module-card-body">
            <div style={{ fontWeight: 600, marginBottom: ".35rem" }}>
              Couldn&apos;t load this period
            </div>
            <div style={{ color: "var(--slate-400)", fontSize: ".9rem" }}>
              {error}
            </div>
            <button
              className="btn-primary"
              style={{ marginTop: "1rem" }}
              onClick={() => load(financialYear, quarter)}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {loading && !a && !error && (
        <div className="module-card" style={{ margin: "0 0 1.5rem" }}>
          <div className="module-card-body" style={{ color: "var(--slate-400)" }}>
            Fetching the latest run for {toApiYear(financialYear)}
            {isAllQuarters(quarter) ? "" : ` ${toApiQuarter(quarter)}`}…
          </div>
        </div>
      )}

      {a && (
        <div className="dashboard-body" style={{ opacity: loading ? 0.55 : 1 }}>
          {/* KPI Row */}
          <div className="kpi-row">
            <div className="kpi-card">
              <div className="kpi-label">Audit Score</div>
              <div className="kpi-value">
                {a.score}
                <span style={{ fontSize: "1rem", color: "var(--slate-400)" }}>
                  /100
                </span>
              </div>
              <div className="kpi-sub">
                {a.matched} of {a.totalChecks} tie-out checks passed
              </div>
            </div>

            <div
              className={`kpi-card${a.warnings + a.criticals > 0 ? " warn" : ""}`}
            >
              <div className="kpi-label">Flagged Items</div>
              <div className="kpi-value">{a.warnings + a.criticals}</div>
              <div className="kpi-sub">
                {a.warnings} warning{a.warnings === 1 ? "" : "s"} · {a.criticals}{" "}
                critical
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Net Margin</div>
              <div className="kpi-value">
                {a.netMargin === null ? "—" : a.netMargin.toFixed(1)}
                {a.netMargin !== null && (
                  <span style={{ fontSize: "1rem", color: "var(--slate-400)" }}>
                    %
                  </span>
                )}
              </div>
              <div
                className={`kpi-sub${
                  a.netMargin !== null && a.netMargin < 0 ? " down" : ""
                }`}
              >
                {a.netMargin === null
                  ? "No revenue booked this period"
                  : "Net income ÷ revenue"}
              </div>
            </div>

            <div className={`kpi-card${a.isBalanced ? "" : " alert"}`}>
              <div className="kpi-label">Balance Check</div>
              <div
                className="kpi-value"
                style={{
                  color: a.isBalanced
                    ? "var(--green-400)"
                    : "var(--red-400, #f87171)",
                  fontSize: "1.6rem",
                }}
              >
                {a.isBalanced ? "✓ Balanced" : "✕ Out"}
              </div>
              <div className="kpi-sub">Assets = Liab + Equity</div>
            </div>

            <div className={`kpi-card${a.suspiciousDocs > 0 ? " alert" : ""}`}>
              <div className="kpi-label">Suspicious Receipts</div>
              <div className="kpi-value">{a.suspiciousDocs}</div>
              <div className={`kpi-sub${a.suspiciousDocs > 0 ? " down" : ""}`}>
                {a.suspiciousDocs > 0
                  ? "Duplicate or flagged upload"
                  : "Nothing flagged"}
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Reconciled</div>
              <div className="kpi-value">
                {a.reconciledPct === null ? "—" : a.reconciledPct}
                {a.reconciledPct !== null && (
                  <span style={{ fontSize: "1rem", color: "var(--slate-400)" }}>
                    %
                  </span>
                )}
              </div>
              <div className="kpi-sub">
                {a.matched} of {a.totalChecks} checks matched
              </div>
            </div>
          </div>

          {/* Main content area */}
          <div className="two-col">
            <div
              style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
            >
              {/* Recent Findings */}
              <div className="module-card">
                <div className="module-card-header">
                  <div className="module-card-title">🔍 Recent Audit Findings</div>
                  <span className="badge badge-amber">{a.runAge}</span>
                </div>
                <div className="module-card-body">
                  {a.findings.length === 0 && (
                    <div style={{ color: "var(--slate-400)" }}>
                      No findings raised for this period.
                    </div>
                  )}
                  {a.findings.map((f, i) => (
                    <div className={`finding-item ${f.level}`} key={i}>
                      <div className={`finding-dot ${f.level}`}></div>
                      <div>
                        <div className="finding-text">
                          <strong>{f.title}</strong>
                          <br />
                          {f.detail}
                        </div>
                        <div className="finding-meta">{f.meta}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Auditor narrative */}
              {a.narrative && (
                <div className="module-card">
                  <div className="module-card-header">
                    <div className="module-card-title">
                      Reconciliation Narrative
                    </div>
                  </div>
                  <div className="module-card-body">
                    {a.narrative
                      .split(/\n\s*\n/)
                      .filter((p) => p.trim())
                      .map((p, i) => (
                        <p
                          key={i}
                          style={{
                            margin: i === 0 ? 0 : ".85rem 0 0",
                            lineHeight: 1.65,
                            fontSize: ".92rem",
                            color: "var(--slate-300, #cbd5e1)",
                          }}
                        >
                          {p.trim()}
                        </p>
                      ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right panel */}
            <div
              style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
            >
              {/* Audit Score */}
              <div className="module-card">
                <div className="module-card-header">
                  <div className="module-card-title">Overall Score</div>
                </div>
                <div className="score-ring-wrap">
                  <div
                    className="score-ring"
                    style={{
                      background: `conic-gradient(var(--${
                        tone(a.score) === "green"
                          ? "green-400, #4ade80"
                          : tone(a.score) === "amber"
                          ? "amber-400, #fbbf24"
                          : "red-400, #f87171"
                      }) ${a.score * 3.6}deg, var(--slate-800, #1e293b) 0deg)`,
                    }}
                  >
                    <div className="score-inner">
                      <span className="score-num">{a.score}</span>
                      <span className="score-label">/ 100</span>
                    </div>
                  </div>
                  <div style={{ marginTop: "1rem", width: "100%" }}>
                    <div className="bar-chart">
                      {[
                        ["P&L", a.modules.pl],
                        ["Balance", a.modules.balance],
                        ["Receipts", a.modules.receipts],
                        ["Recon", a.modules.recon],
                      ].map(([label, value]) => (
                        <div className="bar-row" key={label}>
                          <div className="bar-label">{label}</div>
                          <div className="bar-track">
                            <div
                              className={`bar-fill ${tone(value)}`}
                              style={{ width: `${value}%` }}
                            ></div>
                          </div>
                          <div className="bar-value">{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Module Status */}
              <div className="module-card">
                <div className="module-card-header">
                  <div className="module-card-title">Module Status</div>
                </div>
                <div className="module-card-body">
                  <div className="module-status-grid">
                    <div className="status-tile" onClick={() => showPage?.("pl")}>
                      <div className="status-tile-name">P&amp;L Analysis</div>
                      <div className={`status-tile-status text-${tone(a.modules.pl)}`}>
                        {a.modules.pl >= 90 ? "Passed" : `Score ${a.modules.pl}`}
                      </div>
                    </div>

                    <div
                      className="status-tile"
                      onClick={() => showPage?.("balance")}
                    >
                      <div className="status-tile-name">Balance Sheet</div>
                      <div
                        className={`status-tile-status ${
                          a.isBalanced ? "text-green" : "text-red"
                        }`}
                      >
                        {a.isBalanced ? "Passed" : "Out of balance"}
                      </div>
                    </div>

                    <div
                      className={`status-tile${a.suspiciousDocs > 0 ? " alert" : ""}`}
                      onClick={() => showPage?.("receipts")}
                    >
                      <div className="status-tile-name">Receipts</div>
                      <div
                        className={`status-tile-status ${
                          a.suspiciousDocs > 0 ? "text-red" : "text-green"
                        }`}
                      >
                        {a.suspiciousDocs > 0
                          ? `${a.suspiciousDocs} Flagged`
                          : "Passed"}
                      </div>
                    </div>

                    <div
                      className={`status-tile${a.modules.recon < 90 ? " warn" : ""}`}
                      onClick={() => showPage?.("recon")}
                    >
                      <div className="status-tile-name">Reconciliation</div>
                      <div
                        className={`status-tile-status text-${tone(a.modules.recon)}`}
                      >
                        {a.totalChecks - a.matched > 0
                          ? `${a.totalChecks - a.matched} Gap${
                              a.totalChecks - a.matched > 1 ? "s" : ""
                            }`
                          : "Passed"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Run details */}
              <div className="module-card">
                <div className="module-card-header">
                  <div className="module-card-title">Run Details</div>
                </div>
                <div className="module-card-body">
                  {[
                    ["Run ID", a.meta.runId],
                    ["Pipeline", a.meta.pipeline],
                    ["Document", a.meta.docId],
                    ["Currency", a.currency || "—"],
                    [
                      "Completed",
                      a.meta.completedAt
                        ? new Date(a.meta.completedAt).toLocaleString()
                        : "—",
                    ],
                    ["Model", a.meta.model],
                  ].map(([k, v]) => (
                    <div
                      key={k}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "1rem",
                        padding: ".4rem 0",
                        fontSize: ".82rem",
                      }}
                    >
                      <span style={{ color: "var(--slate-400)" }}>{k}</span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono, ui-monospace, monospace)",
                          textAlign: "right",
                          wordBreak: "break-all",
                        }}
                      >
                        {String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
