"use client";

/**
 * SummaryPage — every number on this page comes from one call to the
 * FinSight lookup agent. No mock data, no layout or class-name changes.
 *
 *   GET  https://.../default/finsight-upload-lookup-agent?run_id=2026-Q4
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

function periodValue(p) {
  if (p == null) return "";
  if (typeof p === "string" || typeof p === "number") return String(p);
  return String(p.value ?? p.id ?? p.label ?? p.name ?? "");
}

/** Builds the DynamoDB partition key format the agent stores runs under: "2026-Q4". */
function buildRunId(financialYear, quarter) {
  const raw = periodValue(financialYear);
  const full = raw.match(/(20\d{2})/);
  const short = raw.match(/(\d{2})(?!.*\d)/);
  const year = full ? full[1] : short ? `20${short[1]}` : raw;

  const q = periodValue(quarter).toLowerCase();
  if (!q || q === "all") return year;
  const qn = q.match(/[1-4]/);
  return qn ? `${year}-Q${qn[0]}` : year;
}

/** Lambda proxy responses nest (and often stringify) the payload. Unwrap up to 3 layers. */
function unwrapPayload(raw) {
  let payload = raw;
  for (let i = 0; i < 3; i += 1) {
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return null;
      }
      continue;
    }
    if (payload && typeof payload === "object" && "body" in payload) {
      payload = payload.body;
      continue;
    }
    if (payload && typeof payload === "object" && "Item" in payload) {
      payload = payload.Item;
      continue;
    }
    break;
  }
  return payload && typeof payload === "object" ? payload : null;
}

async function fetchAuditRun({ runId, financialYear, quarter, signal }) {
  const url = new URL(API_URL);
  url.searchParams.set("run_id", runId);
  url.searchParams.set("financial_year", periodValue(financialYear));
  url.searchParams.set("quarter", periodValue(quarter));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `The lookup agent returned ${res.status}. Check the run_id and that CORS is enabled on the endpoint.`
    );
  }

  const payload = unwrapPayload(await res.json());
  if (!payload) throw new Error("The response was not valid JSON.");
  return payload;
}

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

const MODULES = ["pl", "balance", "receipts", "recon"];

const MODULE_LABEL = {
  pl: "P&L ANALYSIS",
  balance: "BALANCE SHEET",
  receipts: "RECEIPTS",
  recon: "RECONCILIATION",
};

const MODULE_TILE = {
  pl: "P&L Analysis",
  balance: "Balance Sheet",
  receipts: "Receipts",
  recon: "Reconciliation",
};

const BAR_LABEL = { pl: "P&L", balance: "Balance", receipts: "Receipts", recon: "Recon" };

/** Routes a tie-out check name to the module that owns it. */
const CHECK_ROUTES = [
  [/receipt|invoice|duplicate/i, "receipts"],
  [/balance_sheet|cash_agrees|retained_earnings/i, "balance"],
  [/pnl|revenue_ties|expenses_tie|gross_profit/i, "pl"],
];

function moduleForCheck(name = "") {
  for (const [re, mod] of CHECK_ROUTES) if (re.test(name)) return mod;
  return "recon";
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function money(v, currency = "") {
  const n = num(v);
  if (n === null) return "—";
  const body = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "-" : ""}${currency ? `${currency} ` : ""}${body}`;
}

function titleise(s = "") {
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function timeAgo(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "just now";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

function shortModel(id) {
  if (!id) return "—";
  const m = String(id).match(/(claude[\w-]*?)-\d{8}/i);
  return m ? m[1] : id;
}

const SEVERITY_RANK = { alert: 0, warn: 1, ok: 2 };

function derive(data) {
  const pnl = data.pnl_output || {};
  const bsOut = data.balance_sheet_output || {};
  const bs = bsOut.balance_sheet || {};
  const ledger = data.ledger_output || {};
  const recon = data.reconciliation_output || {};
  const extraction = data.extraction_summary || {};

  const currency = pnl.currency || ledger.currency || extraction.currency || "";
  const asOf = recon.generated_at || data.completed_at;

  const tieOuts = Array.isArray(recon.tie_outs) ? recon.tie_outs : [];
  const exceptions = Array.isArray(recon.exceptions) ? recon.exceptions : [];
  const ledgerErrors = Array.isArray(ledger.errors) ? ledger.errors : [];
  const reviewReasons = Array.isArray(extraction.review_reasons)
    ? extraction.review_reasons
    : [];
  const duplicateUpload = extraction.duplicate_upload === true;

  const passed = tieOuts.filter((t) => t.status === "PASS");
  const failed = tieOuts.filter((t) => t.status === "FAIL");
  const skipped = tieOuts.filter((t) => t.status === "SKIPPED");

  const bankRecon = recon.reconciliation || null;
  const bankReconSkipped = Boolean(bankRecon && bankRecon.status === "SKIPPED");

  /* ---- per-module scores ---------------------------------------- */
  const buckets = {};
  MODULES.forEach((m) => {
    buckets[m] = { pass: 0, fail: 0, skip: 0 };
  });

  tieOuts.forEach((t) => {
    const b = buckets[moduleForCheck(t.check)];
    if (t.status === "PASS") b.pass += 1;
    else if (t.status === "FAIL") b.fail += 1;
    else b.skip += 1;
  });
  if (bankReconSkipped) buckets.recon.skip += 1;

  const scores = {};
  MODULES.forEach((m) => {
    const { pass, fail, skip } = buckets[m];
    const total = pass + fail + skip;
    scores[m] = total ? Math.round(((pass + skip * 0.5) / total) * 100) : null;
  });

  // Receipts owns no tie-outs, so score it from extraction quality instead.
  if (Object.keys(extraction).length === 0) {
    scores.receipts = null;
  } else {
    let r = 100;
    if (duplicateUpload) r -= 45;
    r -= reviewReasons.length * 15;
    if (extraction.status && extraction.status !== "normalized") r -= 20;
    scores.receipts = Math.max(0, r);
  }

  const scored = MODULES.map((m) => scores[m]).filter((s) => s !== null);
  const auditScore = scored.length
    ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
    : null;

  /* ---- findings --------------------------------------------------- */
  const findings = [];
  const push = (severity, module, title, detail) =>
    findings.push({ severity, module, title, detail });

  if (duplicateUpload) {
    push(
      "alert",
      "receipts",
      "Duplicate document upload",
      `Document ${extraction.doc_id || "—"} for ${
        extraction.display_total || money(extraction.total_amount, currency)
      } matches a submission already in this run. Confirm it is not counted twice.`
    );
  }

  reviewReasons.forEach((reason) =>
    push(
      "warn",
      "receipts",
      "Extraction flagged for review",
      typeof reason === "string" ? reason : JSON.stringify(reason)
    )
  );

  ledgerErrors.forEach((err) =>
    push(
      "alert",
      "recon",
      "Ledger posting error",
      typeof err === "string" ? err : JSON.stringify(err)
    )
  );

  exceptions.forEach((ex) =>
    push(
      "alert",
      moduleForCheck(ex.check || ex.name),
      ex.title || titleise(ex.check || ex.name || "reconciliation_exception"),
      ex.explanation || ex.message || ex.reason || JSON.stringify(ex)
    )
  );

  failed.forEach((t) =>
    push(
      "alert",
      moduleForCheck(t.check),
      `${titleise(t.check)} failed`,
      `${titleise(t.left_label || "left")} ${money(t.left, currency)} against ${titleise(
        t.right_label || "right"
      )} ${money(t.right, currency)} — difference ${money(t.difference, currency)}.`
    )
  );

  skipped.forEach((t) =>
    push(
      "warn",
      moduleForCheck(t.check),
      `${titleise(t.check)} skipped`,
      t.reason || t.explanation || "Required inputs were not available for this check."
    )
  );

  if (bankReconSkipped) {
    push(
      "warn",
      "recon",
      `${titleise(bankRecon.name || "bank_reconciliation")} skipped`,
      [bankRecon.reason, bankRecon.explanation].filter(Boolean).join(" — ") ||
        "Source documents were not supplied."
    );
  }

  const netIncome = num(pnl.net_income);
  if (netIncome !== null && netIncome < 0) {
    push(
      "warn",
      "pl",
      "Net loss for the period",
      `Revenue ${money(pnl.total_revenue, currency)} against costs ${money(
        pnl.total_expenses ?? pnl.total_operating_expenses,
        currency
      )} leaves a net loss of ${money(Math.abs(netIncome), currency)}.`
    );
  }

  if (bs.is_balanced) {
    push(
      "ok",
      "balance",
      "Balance sheet identity verified",
      `Assets ${money(bs.total_assets, currency)} = Liabilities ${money(
        bs.total_liabilities,
        currency
      )} + Equity ${money(bs.total_equity, currency)}`
    );
  } else if (Object.keys(bs).length) {
    push(
      "alert",
      "balance",
      "Balance sheet does not balance",
      `Assets and liabilities plus equity differ by ${money(bs.imbalance, currency)}.`
    );
  }

  if (ledger.trial_balance && ledger.trial_balance.is_balanced) {
    push(
      "ok",
      "recon",
      "Trial balance in balance",
      `Debits ${money(ledger.trial_balance.total_debit, currency)} equal credits ${money(
        ledger.trial_balance.total_credit,
        currency
      )} across ${ledger.journal_entry_count ?? "—"} journal entries.`
    );
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  /* ---- roll-ups ---------------------------------------------------- */
  const criticalCount = findings.filter((f) => f.severity === "alert").length;
  const warningCount = findings.filter((f) => f.severity === "warn").length;

  const revenue = num(pnl.total_revenue);
  const netMargin = revenue ? (netIncome / revenue) * 100 : null;

  const tileStatus = {};
  MODULES.forEach((m) => {
    const crit = findings.filter((f) => f.module === m && f.severity === "alert").length;
    const warn = findings.filter((f) => f.module === m && f.severity === "warn").length;
    if (crit) tileStatus[m] = { tone: "alert", cls: "text-red", text: `${crit} Critical` };
    else if (warn)
      tileStatus[m] = {
        tone: "warn",
        cls: "text-amber",
        text: `${warn} ${warn === 1 ? "Warning" : "Warnings"}`,
      };
    else tileStatus[m] = { tone: "ok", cls: "text-green", text: "Passed" };
  });

  return {
    currency,
    asOf,
    runId: recon.run_id || pnl.run_id || data.run_id || "—",
    pipelineStatus: data.pipeline_status,
    modelId: recon.model_id,
    period: pnl.period || (ledger.trial_balance && ledger.trial_balance.period),
    pnl,
    bs,
    ledger,
    narrative: recon.narrative,
    passedCount: passed.length,
    tieOutCount: tieOuts.length,
    scores,
    auditScore,
    criticalCount,
    warningCount,
    flaggedCount: criticalCount + warningCount,
    netMargin,
    netIncome,
    findings,
    tileStatus,
    suspiciousReceipts: (duplicateUpload ? 1 : 0) + reviewReasons.length,
  };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export default function SummaryPage({ showPage }) {
  const [financialYear, setFinancialYear] = useState(FINANCIAL_YEARS[0]);
  const [quarter, setQuarter] = useState("all");

  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [showNarrative, setShowNarrative] = useState(false);

  const abortRef = useRef(null);

  const load = useCallback(async (fy, q) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setNotFound(false);

    try {
      const payload = await fetchAuditRun({
        runId: buildRunId(fy, q),
        financialYear: fy,
        quarter: q,
        signal: controller.signal,
      });
      if (!payload) {
        setNotFound(true);
        setView(null);
      } else {
        setView(derive(payload));
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      setError(err.message || "The run could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(financialYear, quarter);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cur = view?.currency || "";
  const dim = { fontSize: "1rem", color: "var(--slate-400)" };

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
            {view
              ? `Run ${view.runId} · ${
                  view.pipelineStatus === "success"
                    ? "Pipeline complete"
                    : titleise(view.pipelineStatus || "status unknown")
                } · Last run ${timeAgo(view.asOf)}`
              : loading
              ? "Loading the latest run…"
              : `Run ${buildRunId(financialYear, quarter)} · not loaded`}
          </div>
        </div>
        <div className="header-actions">
          {view && view.warningCount > 0 && (
            <span className="badge badge-amber">
              {view.warningCount} {view.warningCount === 1 ? "Warning" : "Warnings"}
            </span>
          )}
          {view && view.criticalCount > 0 && (
            <span className="badge badge-red">{view.criticalCount} Critical</span>
          )}
          <button
            className="btn-primary"
            disabled={!view || loading}
            onClick={() => showPage("recon")}
          >
            Generate Summary Report
          </button>
        </div>
      </div>

      <div className="dashboard-body">
        {error && (
          <div className="module-card" style={{ marginBottom: "1.5rem" }}>
            <div className="module-card-body">
              <div className="finding-item alert">
                <div className="finding-dot alert"></div>
                <div>
                  <div className="finding-text">
                    <strong>
                      Could not load run {buildRunId(financialYear, quarter)}
                    </strong>
                    <br />
                    {error}
                  </div>
                  <div className="finding-meta" style={{ marginTop: "0.75rem" }}>
                    <button
                      className="btn-primary"
                      onClick={() => load(financialYear, quarter)}
                    >
                      Try again
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading && !view && (
          <div className="module-card">
            <div className="module-card-body">
              Fetching run {buildRunId(financialYear, quarter)} from the lookup agent…
            </div>
          </div>
        )}

        {notFound && !loading && (
          <div className="module-card">
            <div className="module-card-body">
              No stored run for {buildRunId(financialYear, quarter)}. Upload the documents for
              this period, or pick another period and run again.
            </div>
          </div>
        )}

        {view && (
          <>
            {/* KPI Row */}
            <div className="kpi-row" style={loading ? { opacity: 0.55 } : undefined}>
              <div className="kpi-card">
                <div className="kpi-label">Audit Score</div>
                <div className="kpi-value">
                  {view.auditScore ?? "—"}
                  <span style={dim}>/100</span>
                </div>
                <div className="kpi-sub">
                  {view.passedCount} of {view.tieOutCount} checks passed
                </div>
              </div>

              <div className={`kpi-card${view.flaggedCount ? " warn" : ""}`}>
                <div className="kpi-label">Flagged Items</div>
                <div className="kpi-value">{view.flaggedCount}</div>
                <div className="kpi-sub">
                  {view.warningCount} warnings · {view.criticalCount} critical
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">Net Margin</div>
                <div className="kpi-value">
                  {view.netMargin === null ? "—" : view.netMargin.toFixed(1)}
                  <span style={dim}>%</span>
                </div>
                <div className={`kpi-sub${view.netIncome < 0 ? " down" : " up"}`}>
                  Net {view.netIncome < 0 ? "loss" : "income"}{" "}
                  {money(Math.abs(view.netIncome ?? 0), cur)}
                </div>
              </div>

              <div className={`kpi-card${view.bs.is_balanced ? "" : " alert"}`}>
                <div className="kpi-label">Balance Check</div>
                <div
                  className="kpi-value"
                  style={{
                    color: view.bs.is_balanced ? "var(--green-400)" : undefined,
                    fontSize: "1.6rem",
                  }}
                >
                  {view.bs.is_balanced ? "✓ Balanced" : "✕ Out of balance"}
                </div>
                <div className="kpi-sub">
                  {view.bs.is_balanced
                    ? "Assets = Liab + Equity"
                    : `Off by ${money(view.bs.imbalance, cur)}`}
                </div>
              </div>

              <div className={`kpi-card${view.suspiciousReceipts ? " alert" : ""}`}>
                <div className="kpi-label">Suspicious Receipts</div>
                <div className="kpi-value">{view.suspiciousReceipts}</div>
                <div className={`kpi-sub${view.suspiciousReceipts ? " down" : ""}`}>
                  {view.suspiciousReceipts
                    ? "Duplicate or review-flagged upload"
                    : "No exceptions raised"}
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">Reconciled</div>
                <div className="kpi-value">
                  {view.tieOutCount
                    ? Math.round((view.passedCount / view.tieOutCount) * 100)
                    : "—"}
                  <span style={dim}>%</span>
                </div>
                <div className="kpi-sub">
                  {view.passedCount} of {view.tieOutCount} tie-outs matched
                </div>
              </div>
            </div>

            {/* Main content area */}
            <div className="two-col">
              {/* Recent Findings */}
              <div className="module-card">
                <div className="module-card-header">
                  <div className="module-card-title">🔍 Recent Audit Findings</div>
                  <span className="badge badge-amber">
                    {loading ? "Refreshing" : "Live"}
                  </span>
                </div>
                <div className="module-card-body">
                  {view.findings.length === 0 ? (
                    <div className="finding-item ok">
                      <div className="finding-dot ok"></div>
                      <div>
                        <div className="finding-text">
                          <strong>No findings raised</strong>
                          <br />
                          Every check in this run completed without an exception.
                        </div>
                        <div className="finding-meta">
                          RECONCILIATION · Passed · {timeAgo(view.asOf)}
                        </div>
                      </div>
                    </div>
                  ) : (
                    view.findings.map((f, i) => (
                      <div className={`finding-item ${f.severity}`} key={`${f.title}-${i}`}>
                        <div className={`finding-dot ${f.severity}`}></div>
                        <div>
                          <div className="finding-text">
                            <strong>{f.title}</strong>
                            <br />
                            {f.detail}
                          </div>
                          <div className="finding-meta">
                            {MODULE_LABEL[f.module]} ·{" "}
                            {f.severity === "alert"
                              ? "Critical"
                              : f.severity === "warn"
                              ? "Warning"
                              : "Passed"}{" "}
                            · {timeAgo(view.asOf)}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Right panel */}
              <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                {/* Audit Score */}
                <div className="module-card">
                  <div className="module-card-header">
                    <div className="module-card-title">Overall Score</div>
                  </div>
                  <div className="score-ring-wrap">
                    <div className="score-ring">
                      <div className="score-inner">
                        <span className="score-num">{view.auditScore ?? "—"}</span>
                        <span className="score-label">/ 100</span>
                      </div>
                    </div>
                    <div style={{ marginTop: "1rem", width: "100%" }}>
                      <div className="bar-chart">
                        {MODULES.map((m) => {
                          const s = view.scores[m];
                          const fill = s === null ? 0 : s;
                          const tone = fill >= 90 ? "green" : fill >= 70 ? "amber" : "red";
                          return (
                            <div className="bar-row" key={m}>
                              <div className="bar-label">{BAR_LABEL[m]}</div>
                              <div className="bar-track">
                                <div
                                  className={`bar-fill ${tone}`}
                                  style={{ width: `${fill}%` }}
                                ></div>
                              </div>
                              <div className="bar-value">{s === null ? "—" : s}</div>
                            </div>
                          );
                        })}
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
                      {MODULES.map((m) => {
                        const st = view.tileStatus[m];
                        const extra =
                          st.tone === "alert" ? " alert" : st.tone === "warn" ? " warn" : "";
                        return (
                          <div
                            className={`status-tile${extra}`}
                            key={m}
                            onClick={() => showPage(m)}
                          >
                            <div className="status-tile-name">{MODULE_TILE[m]}</div>
                            <div className={`status-tile-status ${st.cls}`}>{st.text}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Run details */}
                <div className="module-card">
                  <div className="module-card-header">
                    <div className="module-card-title">Run Details</div>
                  </div>
                  <div className="module-card-body">
                    <div className="bar-chart">
                      <RunDetail label="Run ID" value={view.runId} />
                      <RunDetail label="Currency" value={cur || "—"} />
                      <RunDetail
                        label="Period"
                        value={
                          view.period ? `${view.period.start} → ${view.period.end}` : "—"
                        }
                      />
                      <RunDetail
                        label="Entries"
                        value={`${view.ledger.journal_entry_count ?? "—"} journal · ${
                          view.pnl.transaction_count ?? "—"
                        } txns`}
                      />
                      <RunDetail label="Model" value={shortModel(view.modelId)} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Narrative */}
            {view.narrative && (
              <div className="module-card" style={{ marginTop: "1.5rem" }}>
                <div className="module-card-header">
                  <div className="module-card-title">Reconciliation Narrative</div>
                  <button className="btn-primary" onClick={() => setShowNarrative((s) => !s)}>
                    {showNarrative ? "Show less" : "Read full narrative"}
                  </button>
                </div>
                <div className="module-card-body">
                  <div
                    className="finding-text"
                    style={{
                      whiteSpace: "pre-line",
                      maxHeight: showNarrative ? "none" : "5.5em",
                      overflow: "hidden",
                    }}
                  >
                    {view.narrative}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RunDetail({ label, value }) {
  return (
    <div className="bar-row">
      <div className="bar-label">{label}</div>
      <div
        className="bar-value"
        style={{ marginLeft: "auto", textAlign: "right", whiteSpace: "normal" }}
      >
        {value}
      </div>
    </div>
  );
}
