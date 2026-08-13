import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * P&L Analysis page — FinSightOps
 *
 * Talks to API Gateway → Lambda (auditai-output scan):
 *   POST  {endpoint}
 *   body  { "financial_year": "2026", "quarter": "Q4" }
 *
 * The Lambda replies with the latest record for that prefix:
 *   { "statusCode": 200, "body": { pnl_output, ledger_output, ... } }
 *
 * This page reads ONLY `body.pnl_output`. Every other section of the record
 * (ledger, balance sheet, reconciliation, extraction) is ignored here.
 *
 * pnl_output has no prior-period figures, so the page optionally fetches the
 * preceding quarter as a comparison. If that run does not exist, the prior /
 * deviation columns are hidden rather than filled with dashes.
 *
 * Styling relies on the global FinSightOps stylesheet (.pl-table, .tab-bar,
 * .kpi-row, .bar-chart, .finding-item, .badge-*, …). No CSS is imported here.
 */

const DEFAULT_ENDPOINT = "https://j2aac6i6f0.execute-api.ap-southeast-1.amazonaws.com/default/finsight-upload-lookup-agent";

const YEARS = ["2026", "2025", "2024"];
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"]; // the Lambda requires a single quarter

const TABS = [
  { id: "summary", label: "Summary" },
  { id: "income", label: "Income Statement" },
  { id: "margins", label: "Margins & Trends" },
  { id: "flags", label: "Flagged Items" },
];

/* ────────────────────────── helpers ────────────────────────── */

const money = (n, currency = "") =>
  n == null
    ? "—"
    : `${currency ? `${currency} ` : "$"}${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

const pct = (n, digits = 1) =>
  n == null || Number.isNaN(Number(n)) ? "—" : `${Number(n).toFixed(digits)}%`;

const signedPct = (n) =>
  n == null || Number.isNaN(Number(n))
    ? "—"
    : `${Number(n) > 0 ? "+" : ""}${Number(n).toFixed(1)}%`;

const toNumber = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const nullableNumber = (v) =>
  v == null || v === "" ? null : toNumber(v);

const STATUS = {
  ok: { tone: "ok", badge: "badge-green", text: "OK" },
  flag: { tone: "warn", badge: "badge-amber", text: "⚠ Flag" },
  review: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  alert: { tone: "alert", badge: "badge-red", text: "✕ Alert" },
};

const rowClass = (tone) =>
  tone === "alert" ? "error" : tone === "warn" ? "flagged" : "";

const railColor = (tone) =>
  tone === "alert" ? "red" : tone === "warn" ? "amber" : "green";

const varForTone = (tone) =>
  tone === "alert"
    ? "var(--rail-red)"
    : tone === "warn"
    ? "var(--rail-amber)"
    : "var(--rail-green)";

const quarterLabel = (year, quarter) => `${quarter} ${year}`;

/** Q1 rolls back to Q4 of the previous financial year. */
const priorPeriodOf = (year, quarter) => {
  const n = Number(String(quarter).replace(/\D/g, ""));
  if (!n) return null;
  return n === 1
    ? { year: String(Number(year) - 1), quarter: "Q4" }
    : { year, quarter: `Q${n - 1}` };
};

const isoDate = (v) => (v ? String(v).slice(0, 10) : null);

/* ────────────────────────── transport ────────────────────────── */

const messageIn = (body) => {
  if (!body) return "";
  if (typeof body === "string") return body;
  return body.message ?? body.error ?? body.errorMessage ?? "";
};

/**
 * Calls the Lambda and returns the record body.
 * Tolerates both integration styles:
 *   - proxy integration  → response is the JSON string in `body`
 *   - non-proxy / direct → response is the raw dict the Lambda returned
 */
async function fetchRecord({ endpoint, apiKey, year, quarter, signal }) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({ financial_year: year, quarter }),
    signal,
  });

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text; // plain-text error from the gateway
    }
  }

  // The Lambda wraps its own status code inside the payload.
  const wrapped =
    json && typeof json === "object" && "statusCode" in json && "body" in json;
  const code = wrapped ? Number(json.statusCode) : res.status;

  let body = wrapped ? json.body : json;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* the 400 / 404 branches return a bare sentence */
    }
  }

  if (!res.ok || code >= 400) {
    throw new Error(
      messageIn(body) || `The audit service returned status ${code}.`
    );
  }
  return body;
}

/** Pulls pnl_output out of the record, wherever the pipeline nested it. */
function extractPnl(record) {
  if (!record || typeof record !== "object") return null;
  return (
    record.pnl_output ??
    record.body?.pnl_output ??
    record.data?.pnl_output ??
    record.output?.pnl_output ??
    null
  );
}

/* ────────────────────────── normalisation ────────────────────────── */

const firstDefined = (obj, keys) => {
  for (const k of keys) if (obj?.[k] != null) return toNumber(obj[k]);
  return null;
};

const entriesOf = (node) => {
  if (!node) return [];
  if (Array.isArray(node)) {
    return node.map((i) => [
      i.label ?? i.name ?? i.account ?? "Unnamed line",
      i.amount ?? i.value ?? i.total ?? 0,
    ]);
  }
  if (typeof node === "object") return Object.entries(node);
  return [];
};

/** Sections of the statement, in reading order, mapped to pnl_output keys. */
const SECTIONS = [
  { title: "Revenue", itemsKey: "revenue_items", totalKeys: ["total_revenue"] },
  { title: "Cost of Goods Sold", itemsKey: "cogs_items", totalKeys: ["total_cogs"] },
  { title: "Gross Profit", itemsKey: null, totalKeys: ["gross_profit"] },
  {
    title: "Operating Expenses",
    itemsKey: "expense_items",
    totalKeys: ["total_operating_expenses", "total_expenses"],
  },
  { title: "Net Income", itemsKey: null, totalKeys: ["net_income"] },
];

const deviationOf = (current, prior) =>
  prior == null || prior === 0 ? null : ((current - prior) / Math.abs(prior)) * 100;

const statusFor = (deviation, threshold) => {
  if (deviation == null) return STATUS.ok;
  const magnitude = Math.abs(deviation);
  if (magnitude >= threshold * 3) return STATUS.alert;
  if (magnitude >= threshold) return STATUS.flag;
  return STATUS.ok;
};

function normalizePnl(pnl, priorPnl, threshold) {
  const currency = pnl.currency ?? pnl.ccy ?? "";
  const hasComparison = Boolean(priorPnl);

  const groups = SECTIONS.map((section) => {
    const items = entriesOf(section.itemsKey ? pnl[section.itemsKey] : null);
    const priorItems = Object.fromEntries(
      entriesOf(section.itemsKey && priorPnl ? priorPnl[section.itemsKey] : null)
    );

    const lines = items.map(([label, value]) => {
      const current = toNumber(value);
      const prior = hasComparison ? nullableNumber(priorItems[label]) : null;
      const deviation = deviationOf(current, prior);
      const status = statusFor(deviation, threshold);
      return {
        label,
        current,
        prior,
        deviation,
        status,
        section: section.title,
        tone:
          deviation != null && Math.abs(deviation) >= threshold
            ? deviation > 0
              ? "up"
              : "down"
            : null,
        magnitude: deviation == null ? Math.abs(current) : Math.abs(deviation),
        note:
          hasComparison && prior == null
            ? "No matching line in the comparison period."
            : "",
        trend: null,
      };
    });

    const total =
      firstDefined(pnl, section.totalKeys) ??
      (lines.length ? lines.reduce((s, l) => s + l.current, 0) : null);
    const priorTotal = priorPnl ? firstDefined(priorPnl, section.totalKeys) : null;

    return {
      title: section.title,
      items: lines,
      total,
      priorTotal,
      deviation: deviationOf(total ?? 0, priorTotal),
      status: statusFor(deviationOf(total ?? 0, priorTotal), threshold),
    };
  }).filter((g) => g.total != null || g.items.length > 0);

  // Trend bars are scaled against the largest movement in the run — or, with no
  // comparison period, against the largest line in the statement.
  const allLines = groups.flatMap((g) => g.items);
  const maxMagnitude = Math.max(1, ...allLines.map((l) => l.magnitude));
  allLines.forEach((l) => {
    l.trend = Math.round((l.magnitude / maxMagnitude) * 100);
  });

  const totals = {
    revenue: firstDefined(pnl, ["total_revenue"]),
    cogs: firstDefined(pnl, ["total_cogs"]),
    grossProfit: firstDefined(pnl, ["gross_profit"]),
    opex: firstDefined(pnl, ["total_operating_expenses", "total_expenses"]),
    netIncome: firstDefined(pnl, ["net_income"]),
  };
  totals.operatingIncome =
    totals.grossProfit != null && totals.opex != null
      ? totals.grossProfit - totals.opex
      : totals.netIncome;

  const priorTotals = priorPnl
    ? {
        revenue: firstDefined(priorPnl, ["total_revenue"]),
        grossProfit: firstDefined(priorPnl, ["gross_profit"]),
        opex: firstDefined(priorPnl, ["total_operating_expenses", "total_expenses"]),
        netIncome: firstDefined(priorPnl, ["net_income"]),
      }
    : null;

  const marginOf = (value, revenue) =>
    revenue ? (value / revenue) * 100 : null;

  const margins = [
    {
      label: "Gross margin",
      value: marginOf(totals.grossProfit, totals.revenue),
      prior: priorTotals ? marginOf(priorTotals.grossProfit, priorTotals.revenue) : null,
    },
    {
      label: "Operating margin",
      value: marginOf(totals.operatingIncome, totals.revenue),
      prior: priorTotals
        ? marginOf(
            priorTotals.grossProfit != null && priorTotals.opex != null
              ? priorTotals.grossProfit - priorTotals.opex
              : priorTotals.netIncome,
            priorTotals.revenue
          )
        : null,
    },
    {
      label: "Net margin",
      value: marginOf(totals.netIncome, totals.revenue),
      prior: priorTotals ? marginOf(priorTotals.netIncome, priorTotals.revenue) : null,
    },
  ]
    .filter((m) => m.value != null)
    .map((m) => ({
      ...m,
      status: m.value < 0 ? STATUS.alert : STATUS.ok,
    }));

  const flagged = allLines.filter((l) => l.status.tone !== "ok");

  // Checks the P&L can answer on its own, without a comparison period.
  const checks = [];
  if (totals.netIncome != null && totals.netIncome < 0) {
    checks.push({
      tone: "alert",
      text: "The period closed at a net loss.",
      meta: `Net income ${money(totals.netIncome, currency)} on revenue of ${money(
        totals.revenue,
        currency
      )}.`,
    });
  }
  if (totals.revenue === 0 && (totals.opex ?? 0) > 0) {
    checks.push({
      tone: "warn",
      text: "Costs were booked against nil revenue.",
      meta: "Margin ratios cannot be computed for this period.",
    });
  }
  if (!hasComparison) {
    checks.push({
      tone: "warn",
      text: "No comparison period was loaded.",
      meta: "Deviation testing needs the preceding quarter in auditai-output.",
    });
  }

  return {
    runId: pnl.run_id ?? null,
    currency,
    status: pnl.status ?? null,
    transactionCount: pnl.transaction_count ?? null,
    periodStart: isoDate(pnl.period?.start),
    periodEnd: isoDate(pnl.period?.end),
    hasComparison,
    comparisonLabel: "Prior quarter",
    groups,
    margins,
    flagged,
    checks,
    totals,
  };
}

/* ────────────────────────── presentational ────────────────────────── */

function TrendBar({ value, tone }) {
  return (
    <span className="trend-bar" aria-hidden="true">
      <span
        className="trend-fill"
        style={{ width: `${value ?? 0}%`, background: varForTone(tone) }}
      />
    </span>
  );
}

function StatementTable({ data, periodLabel, comparisonLabel }) {
  const { hasComparison, currency } = data;
  const colCount = hasComparison ? 6 : 4;

  return (
    <table className="pl-table">
      <thead>
        <tr>
          <th>Line item</th>
          <th style={{ textAlign: "right" }}>{periodLabel}</th>
          {hasComparison && (
            <>
              <th style={{ textAlign: "right" }}>{comparisonLabel}</th>
              <th style={{ textAlign: "right" }}>Deviation</th>
            </>
          )}
          <th style={{ width: 80 }}>Trend</th>
          {hasComparison && <th style={{ width: 100 }}>Status</th>}
        </tr>
      </thead>
      <tbody>
        {data.groups.map((group) => (
          <Fragment key={group.title}>
            <tr className="head-row">
              <td>{group.title.toUpperCase()}</td>
              <td className="num">{money(group.total, currency)}</td>
              {hasComparison && (
                <>
                  <td className="num">{money(group.priorTotal, currency)}</td>
                  <td className="num">{signedPct(group.deviation)}</td>
                </>
              )}
              <td colSpan={hasComparison ? 2 : 1} />
            </tr>

            {group.items.map((line) => (
              <tr
                key={`${group.title}-${line.label}`}
                className={rowClass(line.status.tone)}
              >
                <td>
                  {line.label}
                  {line.note ? <div className="finding-meta">{line.note}</div> : null}
                </td>
                <td className="num">{money(line.current, currency)}</td>
                {hasComparison && (
                  <>
                    <td className="num">{money(line.prior, currency)}</td>
                    <td className="num">
                      <span className={`deviation ${line.tone ?? ""}`}>
                        {signedPct(line.deviation)}
                      </span>
                    </td>
                  </>
                )}
                <td>
                  <TrendBar value={line.trend} tone={line.status.tone} />
                </td>
                {hasComparison && (
                  <td>
                    <span className={`badge ${line.status.badge}`}>
                      {line.status.text}
                    </span>
                  </td>
                )}
              </tr>
            ))}

            {group.items.length === 0 && group.title !== "Gross Profit" &&
            group.title !== "Net Income" ? (
              <tr>
                <td colSpan={colCount} className="finding-meta">
                  No lines booked to {group.title.toLowerCase()} this period.
                </td>
              </tr>
            ) : null}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function Findings({ data }) {
  const items = [
    ...data.flagged.map((line) => ({
      tone: line.status.tone,
      text: (
        <>
          <strong>{line.label}</strong> moved {signedPct(line.deviation)} against the
          prior quarter.
        </>
      ),
      meta: `${money(line.prior, data.currency)} → ${money(line.current, data.currency)}`,
    })),
    ...data.checks,
  ];

  if (items.length === 0) {
    return <div className="empty-state">Every line came in within tolerance.</div>;
  }

  return (
    <div>
      {items.map((item, i) => (
        <div key={i} className={`finding-item ${item.tone}`}>
          <span className={`finding-dot ${item.tone}`} />
          <div>
            <div className="finding-text">{item.text}</div>
            {item.meta ? <div className="finding-meta">{item.meta}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function SummaryTab({ data }) {
  const { totals, currency } = data;
  const marginSub = (value) =>
    totals.revenue ? `${pct((value / totals.revenue) * 100)} margin` : null;

  const cards = [
    { label: "Revenue", value: totals.revenue, sub: null },
    { label: "Gross profit", value: totals.grossProfit, sub: marginSub(totals.grossProfit) },
    { label: "Operating expenses", value: totals.opex, sub: null },
    { label: "Net income", value: totals.netIncome, sub: marginSub(totals.netIncome) },
  ].filter((c) => c.value != null);

  return (
    <div style={{ padding: "1.5rem" }}>
      <div className="kpi-row">
        {cards.map((c) => (
          <div key={c.label} className={`kpi-card ${c.value < 0 ? "alert" : ""}`}>
            <div className="kpi-label">{c.label}</div>
            <div className="kpi-value">{money(c.value, currency)}</div>
            {c.sub ? <div className="kpi-sub">{c.sub}</div> : null}
          </div>
        ))}
      </div>

      <div className="separator" />

      <div className="section-title">What the run found</div>
      <Findings data={data} />
    </div>
  );
}

function MarginsTab({ data }) {
  if (data.margins.length === 0) {
    return (
      <div className="empty-state">
        Revenue was nil this period, so margins cannot be calculated.
      </div>
    );
  }

  return (
    <div style={{ padding: "1.5rem" }}>
      <div className="bar-chart">
        {data.margins.map((m) => (
          <div className="bar-row" key={m.label}>
            <span className="bar-label">{m.label}</span>
            <span className="bar-track">
              <span
                className={`bar-fill ${railColor(m.status?.tone)}`}
                style={{ width: `${Math.min(100, Math.max(0, m.value))}%` }}
              />
            </span>
            <span className="bar-value">{pct(m.value)}</span>
          </div>
        ))}
      </div>

      {data.margins.some((m) => m.prior != null) && (
        <>
          <div className="separator" />
          <table className="pl-table">
            <thead>
              <tr>
                <th>Margin</th>
                <th style={{ textAlign: "right" }}>Current</th>
                <th style={{ textAlign: "right" }}>{data.comparisonLabel}</th>
                <th style={{ textAlign: "right" }}>Change</th>
              </tr>
            </thead>
            <tbody>
              {data.margins.map((m) => (
                <tr key={m.label}>
                  <td>{m.label}</td>
                  <td className="num">{pct(m.value)}</td>
                  <td className="num">{pct(m.prior)}</td>
                  <td className="num">
                    {m.prior == null ? "—" : `${(m.value - m.prior).toFixed(1)} pts`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function FlagsTab({ data }) {
  if (data.flagged.length === 0) {
    return (
      <div style={{ padding: "1.5rem" }}>
        <Findings data={data} />
      </div>
    );
  }

  return (
    <>
      <table className="pl-table">
        <thead>
          <tr>
            <th>Line item</th>
            <th>Section</th>
            <th style={{ textAlign: "right" }}>Deviation</th>
            <th>Why it was flagged</th>
            <th style={{ width: 100 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.flagged.map((line) => (
            <tr key={`${line.section}-${line.label}`} className={rowClass(line.status.tone)}>
              <td>{line.label}</td>
              <td>{line.section}</td>
              <td className="num">
                <span className={`deviation ${line.tone ?? ""}`}>
                  {signedPct(line.deviation)}
                </span>
              </td>
              <td>{line.note || "Movement exceeds the configured materiality threshold."}</td>
              <td>
                <span className={`badge ${line.status.badge}`}>{line.status.text}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.checks.length > 0 && (
        <div style={{ padding: "1.5rem" }}>
          <Findings data={{ ...data, flagged: [] }} />
        </div>
      )}
    </>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function ProfitAndLoss({
  endpoint = DEFAULT_ENDPOINT,
  apiKey = "",
  initialYear = "2026",
  initialQuarter = "Q4",
  deviationThreshold = 10,
  comparePriorQuarter = true,
  autoRun = true,
}) {
  const [year, setYear] = useState(initialYear);
  const [quarter, setQuarter] = useState(initialQuarter);
  const [tab, setTab] = useState("income");
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(null); // the period actually on screen
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  const runId = useMemo(() => `${year}-${quarter}`, [year, quarter]);

  const fetchPL = useCallback(
    async (y, q) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus("loading");
      setError("");

      try {
        const record = await fetchRecord({
          endpoint,
          apiKey,
          year: y,
          quarter: q,
          signal: controller.signal,
        });

        const pnl = extractPnl(record);
        if (!pnl) {
          throw new Error(
            `Run ${y}-${q} was found, but it carries no pnl_output section.`
          );
        }

        // The comparison quarter is best-effort: a missing run is not an error.
        let priorPnl = null;
        const prior = comparePriorQuarter ? priorPeriodOf(y, q) : null;
        if (prior) {
          try {
            const priorRecord = await fetchRecord({
              endpoint,
              apiKey,
              year: prior.year,
              quarter: prior.quarter,
              signal: controller.signal,
            });
            priorPnl = extractPnl(priorRecord);
          } catch (err) {
            if (err.name === "AbortError") return;
            priorPnl = null;
          }
        }

        setData(normalizePnl(pnl, priorPnl, deviationThreshold));
        setLoaded({ year: y, quarter: q, prior: priorPnl ? prior : null });
        setStatus("ready");
      } catch (err) {
        if (err.name === "AbortError") return;
        setError(err.message || "Could not reach the audit service.");
        setStatus("error");
      }
    },
    [endpoint, apiKey, deviationThreshold, comparePriorQuarter]
  );

  useEffect(() => {
    if (autoRun) fetchPL(initialYear, initialQuarter);
    return () => abortRef.current?.abort();
    // Runs once on mount; later refreshes come from the Run button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const periodLabel = loaded
    ? quarterLabel(loaded.year, loaded.quarter)
    : quarterLabel(year, quarter);

  const comparisonLabel = loaded?.prior
    ? quarterLabel(loaded.prior.year, loaded.prior.quarter)
    : "Prior quarter";

  const dateRange =
    data?.periodStart && data?.periodEnd
      ? `${data.periodStart} → ${data.periodEnd}`
      : null;

  const flagCount = (data?.flagged.length ?? 0) + (data?.checks.length ?? 0);

  return (
    <div className="page">
      {/* period filter */}
      <div className="period-filter-bar">
        <div className="period-filter-fields">
          <div className="period-filter-group">
            <label className="period-filter-label" htmlFor="pl-year">
              Financial year
            </label>
            <select
              id="pl-year"
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
            <label className="period-filter-label" htmlFor="pl-quarter">
              Quarter
            </label>
            <select
              id="pl-quarter"
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
          onClick={() => fetchPL(year, quarter)}
          disabled={status === "loading"}
        >
          {status === "loading" ? "Running…" : "Run"}
        </button>

        <span className="run-card-id">run_id: {runId}</span>
      </div>

      {/* header */}
      <div className="page-header">
        <div>
          <h2>P&amp;L Analysis</h2>
          <div className="sub">
            {periodLabel} · Margins, trends &amp; deviation flags
            {dateRange ? ` · ${dateRange}` : ""}
          </div>
        </div>

        {status === "ready" && data ? (
          <div className="header-actions">
            <span className={`badge ${flagCount > 0 ? "badge-amber" : "badge-green"}`}>
              {flagCount > 0
                ? `${flagCount} warning${flagCount === 1 ? "" : "s"}`
                : "No warnings"}
            </span>
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
              {t.id === "flags" && flagCount > 0 ? ` (${flagCount})` : ""}
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
                onClick={() => fetchPL(year, quarter)}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {status === "idle" && (
          <div className="run-empty-state">
            <p>Pick a financial year and quarter, then select Run to load the P&amp;L.</p>
          </div>
        )}

        {status === "ready" && data && (
          <div className="module-card">
            <div className="module-card-header">
              <span className="module-card-title">
                {TABS.find((t) => t.id === tab).label} — {periodLabel}
              </span>
              <span className="run-card-id">
                {data.hasComparison ? `vs ${comparisonLabel}` : "No comparison period"}
                {data.transactionCount != null
                  ? ` · ${data.transactionCount} transactions`
                  : ""}
              </span>
            </div>

            {data.groups.length === 0 ? (
              <div className="empty-state">Run {runId} returned no P&amp;L lines.</div>
            ) : (
              <>
                {tab === "summary" && <SummaryTab data={data} />}
                {tab === "income" && (
                  <StatementTable
                    data={data}
                    periodLabel={periodLabel}
                    comparisonLabel={comparisonLabel}
                  />
                )}
                {tab === "margins" && <MarginsTab data={data} />}
                {tab === "flags" && <FlagsTab data={data} />}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
