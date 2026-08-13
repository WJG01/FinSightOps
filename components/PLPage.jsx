import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * P&L Analysis page — FinSightOps
 *
 * Talks to API Gateway:
 *   POST  {endpoint}
 *   body  { "run_id": "2026-Q1" }
 *
 * Styling relies on the global FinSightOps stylesheet (.pl-table, .tab-bar,
 * .kpi-row, .bar-chart, .finding-item, .badge-*, …). No CSS is imported here.
 */

const DEFAULT_ENDPOINT =
  "test";

const YEARS = ["2026", "2025", "2024"];
const QUARTERS = ["All", "Q1", "Q2", "Q3", "Q4"];

const TABS = [
  { id: "summary", label: "Summary" },
  { id: "income", label: "Income Statement" },
  { id: "margins", label: "Margins & Trends" },
  { id: "flags", label: "Flagged Items" },
];

/* ────────────────────────── helpers ────────────────────────── */

const money = (n) =>
  n == null ? "—" : `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

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

const nullableNumber = (v) => (v == null || v === "" ? null : toNumber(v));

const STATUS = {
  ok: { tone: "ok", badge: "badge-green", text: "OK" },
  pass: { tone: "ok", badge: "badge-green", text: "OK" },
  flag: { tone: "warn", badge: "badge-amber", text: "⚠ Flag" },
  flagged: { tone: "warn", badge: "badge-amber", text: "⚠ Flag" },
  warn: { tone: "warn", badge: "badge-amber", text: "⚠ Flag" },
  warning: { tone: "warn", badge: "badge-amber", text: "⚠ Flag" },
  review: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  error: { tone: "alert", badge: "badge-red", text: "✕ Error" },
  fail: { tone: "alert", badge: "badge-red", text: "✕ Error" },
  alert: { tone: "alert", badge: "badge-red", text: "✕ Error" },
};
const statusOf = (raw) => STATUS[String(raw ?? "ok").toLowerCase()] ?? STATUS.ok;

const rowClass = (tone) =>
  tone === "alert" ? "error" : tone === "warn" ? "flagged" : "";

const railColor = (tone) => (tone === "alert" ? "red" : tone === "warn" ? "amber" : "green");

const varForTone = (tone) =>
  tone === "alert"
    ? "var(--rail-red)"
    : tone === "warn"
    ? "var(--rail-amber)"
    : "var(--rail-green)";

/* ────────────────────────── normalisation ────────────────────────── */

const normalizeLine = (raw = {}, threshold) => {
  const current = toNumber(raw.current ?? raw.amount ?? raw.value ?? raw.actual);
  const prior = nullableNumber(raw.prior ?? raw.previous ?? raw.comparison ?? raw.py);

  const deviation =
    raw.deviation_pct != null
      ? toNumber(raw.deviation_pct)
      : raw.deviation != null
      ? toNumber(raw.deviation)
      : prior
      ? ((current - prior) / Math.abs(prior)) * 100
      : null;

  const status = statusOf(raw.status);
  const magnitude = deviation == null ? 0 : Math.abs(deviation);

  return {
    label: raw.label ?? raw.item ?? raw.line_item ?? raw.name ?? "Unnamed line",
    current,
    prior,
    deviation,
    // Tint the deviation only once it clears the materiality threshold.
    tone:
      raw.tone ??
      (magnitude >= threshold ? (deviation > 0 ? "up" : "down") : null),
    trend: raw.trend != null ? Math.min(100, Math.max(0, toNumber(raw.trend))) : null,
    magnitude,
    status,
    note: raw.note ?? raw.message ?? raw.finding ?? "",
  };
};

/**
 * Accepts either shape:
 *   { groups: [{ title, items: [...], total, prior_total }] }
 *   { revenue: [...], cost_of_goods_sold: [...], operating_expenses: [...] }
 * and tolerates a `data` / `pl` wrapper.
 */
function normalizeResponse(payload, threshold) {
  const root = payload?.data ?? payload ?? {};
  const src = root.pl ?? root.profit_and_loss ?? root;

  const FALLBACK_GROUPS = [
    ["revenue", "Revenue"],
    ["cost_of_goods_sold", "Cost of Goods Sold"],
    ["gross_profit", "Gross Profit"],
    ["operating_expenses", "Operating Expenses"],
    ["operating_income", "Operating Income"],
    ["net_income", "Net Income"],
  ];

  const rawGroups = Array.isArray(src.groups)
    ? src.groups
    : FALLBACK_GROUPS.filter(([key]) => src[key] != null).map(([key, title]) => {
        const node = src[key];
        return Array.isArray(node) ? { title, items: node } : { title, ...node };
      });

  const groups = rawGroups.map((g) => {
    const items = (g.items ?? g.lines ?? g.rows ?? []).map((i) =>
      normalizeLine(i, threshold)
    );
    const total =
      g.total != null
        ? toNumber(g.total)
        : items.length
        ? items.reduce((s, i) => s + i.current, 0)
        : null;
    const priorTotal =
      g.prior_total != null
        ? toNumber(g.prior_total)
        : items.length && items.every((i) => i.prior != null)
        ? items.reduce((s, i) => s + (i.prior ?? 0), 0)
        : null;

    return {
      title: g.title ?? g.label ?? "Section",
      items,
      total,
      priorTotal,
      deviation:
        g.deviation_pct != null
          ? toNumber(g.deviation_pct)
          : priorTotal
          ? ((total - priorTotal) / Math.abs(priorTotal)) * 100
          : null,
      status: statusOf(g.status),
    };
  });

  // Scale the trend bars against the largest movement in the run.
  const allLines = groups.flatMap((g) => g.items);
  const maxMagnitude = Math.max(1, ...allLines.map((l) => l.magnitude));
  allLines.forEach((l) => {
    if (l.trend == null) l.trend = Math.round((l.magnitude / maxMagnitude) * 100);
  });

  const groupTotal = (re) =>
    groups.find((g) => re.test(g.title))?.total ?? null;

  const revenue = nullableNumber(src.totals?.revenue) ?? groupTotal(/revenue|income from/i);
  const cogs = nullableNumber(src.totals?.cogs) ?? groupTotal(/cost of goods|cogs/i);
  const opex = nullableNumber(src.totals?.operating_expenses) ?? groupTotal(/operating expense/i);
  const grossProfit =
    nullableNumber(src.totals?.gross_profit) ??
    (revenue != null && cogs != null ? revenue - cogs : null);
  const operatingIncome =
    nullableNumber(src.totals?.operating_income) ??
    (grossProfit != null && opex != null ? grossProfit - opex : null);
  const netIncome =
    nullableNumber(src.totals?.net_income) ?? groupTotal(/net income/i) ?? operatingIncome;

  const marginPct = (v) => (revenue ? (v / revenue) * 100 : null);

  const margins = Array.isArray(src.margins)
    ? src.margins.map((m) => ({
        label: m.label ?? m.name,
        value: toNumber(m.value_pct ?? m.value),
        prior: nullableNumber(m.prior_pct ?? m.prior),
        status: statusOf(m.status),
      }))
    : [
        { label: "Gross margin", value: marginPct(grossProfit) },
        { label: "Operating margin", value: marginPct(operatingIncome) },
        { label: "Net margin", value: marginPct(netIncome) },
      ]
        .filter((m) => m.value != null)
        .map((m) => ({ ...m, prior: null, status: STATUS.ok }));

  const flagged = allLines.filter((l) => l.status.tone !== "ok");

  return {
    runId: root.run_id ?? src.run_id ?? null,
    periodLabel: root.period_label ?? src.period_label ?? null,
    comparisonLabel: root.comparison_label ?? src.comparison_label ?? "Prior period",
    groups,
    margins,
    flagged,
    totals: { revenue, cogs, grossProfit, opex, operatingIncome, netIncome },
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

function StatementTable({ data }) {
  const colCount = 6;
  return (
    <table className="pl-table">
      <thead>
        <tr>
          <th>Line item</th>
          <th style={{ textAlign: "right" }}>{data.periodLabel ?? "Current"}</th>
          <th style={{ textAlign: "right" }}>{data.comparisonLabel}</th>
          <th style={{ textAlign: "right" }}>Deviation</th>
          <th style={{ width: 80 }}>Trend</th>
          <th style={{ width: 100 }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {data.groups.map((group) => (
          <Fragment key={group.title}>
            <tr className="head-row">
              <td>{group.title.toUpperCase()}</td>
              {group.items.length === 0 ? (
                <>
                  <td className="num">{money(group.total)}</td>
                  <td className="num">{money(group.priorTotal)}</td>
                  <td className="num">{signedPct(group.deviation)}</td>
                  <td colSpan={2} />
                </>
              ) : (
                <td colSpan={colCount - 1} />
              )}
            </tr>

            {group.items.map((line) => (
              <tr key={`${group.title}-${line.label}`} className={rowClass(line.status.tone)}>
                <td>
                  {line.label}
                  {line.note ? <div className="finding-meta">{line.note}</div> : null}
                </td>
                <td className="num">{money(line.current)}</td>
                <td className="num">{money(line.prior)}</td>
                <td className="num">
                  <span className={`deviation ${line.tone ?? ""}`}>
                    {signedPct(line.deviation)}
                  </span>
                </td>
                <td>
                  <TrendBar value={line.trend} tone={line.status.tone} />
                </td>
                <td>
                  <span className={`badge ${line.status.badge}`}>{line.status.text}</span>
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function SummaryTab({ data }) {
  const { totals } = data;
  const cards = [
    { label: "Revenue", value: totals.revenue, sub: null },
    {
      label: "Gross profit",
      value: totals.grossProfit,
      sub: totals.revenue ? `${pct((totals.grossProfit / totals.revenue) * 100)} margin` : null,
    },
    {
      label: "Operating income",
      value: totals.operatingIncome,
      sub: totals.revenue
        ? `${pct((totals.operatingIncome / totals.revenue) * 100)} margin`
        : null,
    },
    {
      label: "Net income",
      value: totals.netIncome,
      sub: totals.revenue ? `${pct((totals.netIncome / totals.revenue) * 100)} margin` : null,
    },
  ].filter((c) => c.value != null);

  return (
    <div style={{ padding: "1.5rem" }}>
      <div className="kpi-row">
        {cards.map((c) => (
          <div key={c.label} className={`kpi-card ${c.value < 0 ? "alert" : ""}`}>
            <div className="kpi-label">{c.label}</div>
            <div className="kpi-value">{money(c.value)}</div>
            {c.sub ? <div className="kpi-sub">{c.sub}</div> : null}
          </div>
        ))}
      </div>

      <div className="separator" />

      <div className="section-title">What the run found</div>
      {data.flagged.length === 0 ? (
        <div className="empty-state">Every line came in within tolerance.</div>
      ) : (
        <div>
          {data.flagged.map((line) => (
            <div key={line.label} className={`finding-item ${line.status.tone}`}>
              <span className={`finding-dot ${line.status.tone}`} />
              <div>
                <div className="finding-text">
                  <strong>{line.label}</strong> moved {signedPct(line.deviation)} against{" "}
                  {data.comparisonLabel.toLowerCase()}.
                </div>
                <div className="finding-meta">
                  {money(line.prior)} → {money(line.current)}
                  {line.note ? ` · ${line.note}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MarginsTab({ data }) {
  if (data.margins.length === 0) {
    return <div className="empty-state">This run returned no margin series.</div>;
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
                <th style={{ textAlign: "right" }}>{data.periodLabel ?? "Current"}</th>
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
    return <div className="empty-state">No flags raised on this run.</div>;
  }
  return (
    <table className="pl-table">
      <thead>
        <tr>
          <th>Line item</th>
          <th style={{ textAlign: "right" }}>Deviation</th>
          <th>Why it was flagged</th>
          <th style={{ width: 100 }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {data.flagged.map((line) => (
          <tr key={line.label} className={rowClass(line.status.tone)}>
            <td>{line.label}</td>
            <td className="num">
              <span className={`deviation ${line.tone ?? ""}`}>{signedPct(line.deviation)}</span>
            </td>
            <td>{line.note || "Movement exceeds the configured materiality threshold."}</td>
            <td>
              <span className={`badge ${line.status.badge}`}>{line.status.text}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function ProfitAndLoss({
  endpoint = DEFAULT_ENDPOINT,
  apiKey = "",
  initialYear = "2026",
  initialQuarter = "Q1",
  deviationThreshold = 10,
  autoRun = true,
}) {
  const [year, setYear] = useState(initialYear);
  const [quarter, setQuarter] = useState(initialQuarter);
  const [tab, setTab] = useState("income");
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  const runId = useMemo(
    () => (quarter === "All" ? year : `${year}-${quarter}`),
    [year, quarter]
  );

  const fetchPL = useCallback(
    async (id) => {
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
          body: JSON.stringify({ run_id: id }),
          signal: controller.signal,
        });

        if (!res.ok) {
          let detail = "";
          try {
            const body = await res.json();
            detail = body?.message ?? body?.error ?? "";
          } catch {
            /* non-JSON error body */
          }
          throw new Error(detail || `Request failed with status ${res.status}.`);
        }

        const json = await res.json();
        // API Gateway proxy integrations sometimes nest the payload as a string.
        const payload = typeof json?.body === "string" ? JSON.parse(json.body) : json;

        setData(normalizeResponse(payload, deviationThreshold));
        setStatus("ready");
      } catch (err) {
        if (err.name === "AbortError") return;
        setError(err.message || "Could not reach the audit service.");
        setStatus("error");
      }
    },
    [endpoint, apiKey, deviationThreshold]
  );

  useEffect(() => {
    if (autoRun) fetchPL(runId);
    return () => abortRef.current?.abort();
    // Runs once on mount; later refreshes come from the Run button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const periodLabel =
    data?.periodLabel ?? (quarter === "All" ? `FY ${year}` : `${quarter} ${year}`);
  const flagCount = data?.flagged.length ?? 0;

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
          onClick={() => fetchPL(runId)}
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
          <div className="sub">{periodLabel} · Margins, trends &amp; deviation flags</div>
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
                onClick={() => fetchPL(runId)}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {status === "idle" && (
          <div className="run-empty-state">
            <p>Pick a period and select Run to load the P&amp;L.</p>
          </div>
        )}

        {status === "ready" && data && (
          <div className="module-card">
            <div className="module-card-header">
              <span className="module-card-title">
                {TABS.find((t) => t.id === tab).label} — {periodLabel}
              </span>
              <span className="run-card-id">
                vs {data.comparisonLabel}
              </span>
            </div>

            {data.groups.length === 0 && tab === "income" ? (
              <div className="empty-state">Run {runId} returned no P&amp;L lines.</div>
            ) : (
              <>
                {tab === "summary" && <SummaryTab data={data} />}
                {tab === "income" && <StatementTable data={data} />}
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
