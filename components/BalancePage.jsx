import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Balance Sheet page — FinSightOps
 *
 * Talks to API Gateway:
 *   POST  {endpoint}
 *   body  { "run_id": "2026-Q1" }
 *
 * Styling relies on the global FinSightOps stylesheet (.module-card, .pl-table,
 * .bs-split, .period-filter-bar, .badge-*, …). No CSS is imported here.
 */

const DEFAULT_ENDPOINT =
  "test";

const YEARS = ["2026", "2025", "2024"];
const QUARTERS = ["All", "Q1", "Q2", "Q3", "Q4"];

/* ────────────────────────── helpers ────────────────────────── */

const money = (n) =>
  `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

const toNumber = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Maps whatever the API calls a status onto the three rail colours. */
const STATUS = {
  ok: { tone: "ok", badge: "badge-green", text: "OK" },
  pass: { tone: "ok", badge: "badge-green", text: "OK" },
  review: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  warn: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  warning: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  flagged: { tone: "warn", badge: "badge-amber", text: "⚠ Review" },
  error: { tone: "alert", badge: "badge-red", text: "✕ Error" },
  fail: { tone: "alert", badge: "badge-red", text: "✕ Error" },
  alert: { tone: "alert", badge: "badge-red", text: "✕ Error" },
};
const statusOf = (raw) => STATUS[String(raw ?? "ok").toLowerCase()] ?? STATUS.ok;

/** Row-level class the stylesheet expects on <tr>. */
const rowClass = (tone) =>
  tone === "alert" ? "error" : tone === "warn" ? "flagged" : "";

const SECTION_MAP = [
  ["current_assets", "Current Assets", "assets"],
  ["non_current_assets", "Non-Current Assets", "assets"],
  ["current_liabilities", "Current Liabilities", "liabilities"],
  ["non_current_liabilities", "Non-Current Liabilities", "liabilities"],
  ["shareholders_equity", "Shareholders' Equity", "liabilities"],
];

const normalizeItem = (raw = {}) => ({
  label: raw.label ?? raw.item ?? raw.name ?? "Unnamed line",
  amount: toNumber(raw.amount ?? raw.value ?? raw.balance),
  status: statusOf(raw.status),
  note: raw.note ?? raw.message ?? raw.finding ?? "",
});

const normalizeSection = (raw = {}, fallbackTitle = "", fallbackSide = "assets") => {
  const items = (raw.items ?? raw.lines ?? raw.rows ?? []).map(normalizeItem);
  return {
    title: raw.title ?? raw.label ?? fallbackTitle,
    side: (raw.side ?? fallbackSide).startsWith("liab") ? "liabilities" : "assets",
    items,
    total:
      raw.total != null
        ? toNumber(raw.total)
        : items.reduce((sum, i) => sum + i.amount, 0),
  };
};

/**
 * Accepts either shape:
 *   { sections: [{ title, side, total, items: [...] }, ...] }
 *   { current_assets: { total, items }, current_liabilities: {...}, ... }
 * and tolerates a `data` / `balance_sheet` wrapper.
 */
function normalizeResponse(payload) {
  const root = payload?.data ?? payload ?? {};
  const src = root.balance_sheet ?? root;

  let sections = [];
  if (Array.isArray(src.sections)) {
    sections = src.sections.map((s) => normalizeSection(s, s.title, s.side));
  } else {
    sections = SECTION_MAP.filter(([key]) => src[key]).map(([key, title, side]) => {
      const node = src[key];
      return normalizeSection(
        Array.isArray(node) ? { items: node } : node,
        title,
        side
      );
    });
  }

  const sum = (side) =>
    sections.filter((s) => s.side === side).reduce((t, s) => t + s.total, 0);

  const equitySection = sections.find((s) => /equity/i.test(s.title));
  const equity =
    src.identity?.equity != null
      ? toNumber(src.identity.equity)
      : equitySection?.total ?? 0;
  const assets =
    src.identity?.assets != null ? toNumber(src.identity.assets) : sum("assets");
  const liabilities =
    src.identity?.liabilities != null
      ? toNumber(src.identity.liabilities)
      : sum("liabilities") - equity;

  const drift = Math.abs(assets - (liabilities + equity));

  return {
    runId: root.run_id ?? src.run_id ?? null,
    periodLabel: root.period_label ?? src.period_label ?? null,
    sections,
    identity: {
      assets,
      liabilities,
      equity,
      balanced: src.identity?.balanced ?? drift < 1,
    },
    warnings: sections
      .flatMap((s) => s.items)
      .filter((i) => i.status.tone !== "ok").length,
  };
}

/* ────────────────────────── presentational ────────────────────────── */

function SectionCard({ section }) {
  return (
    <div className="module-card" style={{ marginBottom: "1.5rem" }}>
      <div className="module-card-header">
        <span className="module-card-title">{section.title}</span>
        <span className="badge badge-green mono">{money(section.total)}</span>
      </div>

      {section.items.length === 0 ? (
        <div className="empty-state">No lines reported for this section.</div>
      ) : (
        <table className="pl-table">
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th style={{ width: 110 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {section.items.map((item) => (
              <tr key={item.label} className={rowClass(item.status.tone)}>
                <td>
                  {item.label}
                  {item.note ? (
                    <div className="finding-meta">{item.note}</div>
                  ) : null}
                </td>
                <td className="num">{money(item.amount)}</td>
                <td>
                  <span className={`badge ${item.status.badge}`}>
                    {item.status.text}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function IdentityBar({ identity }) {
  const { assets, liabilities, equity, balanced } = identity;
  return (
    <div className="bs-verify-bar">
      <div>
        <div className="bs-verify-label">Accounting identity check</div>
        <div className="bs-verify-eq">
          {money(assets)} = {money(liabilities)} + {money(equity)}
        </div>
      </div>
      <div
        className={`bs-verify-status ${balanced ? "text-green" : "text-red"}`}
      >
        {balanced ? "✓ Balanced" : "✕ Out of balance"}
      </div>
    </div>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function BalanceSheet({
  endpoint = DEFAULT_ENDPOINT,
  apiKey = "",
  initialYear = "2026",
  initialQuarter = "Q1",
  autoRun = true,
}) {
  const [year, setYear] = useState(initialYear);
  const [quarter, setQuarter] = useState(initialQuarter);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  const runId = useMemo(
    () => (quarter === "All" ? year : `${year}-${quarter}`),
    [year, quarter]
  );

  const fetchBalanceSheet = useCallback(
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
          throw new Error(
            detail || `Request failed with status ${res.status}.`
          );
        }

        const json = await res.json();
        // API Gateway proxy integrations sometimes nest the payload as a string.
        const payload =
          typeof json?.body === "string" ? JSON.parse(json.body) : json;

        setData(normalizeResponse(payload));
        setStatus("ready");
      } catch (err) {
        if (err.name === "AbortError") return;
        setError(err.message || "Could not reach the audit service.");
        setStatus("error");
      }
    },
    [endpoint, apiKey]
  );

  useEffect(() => {
    if (autoRun) fetchBalanceSheet(runId);
    return () => abortRef.current?.abort();
    // Runs once on mount; later refreshes come from the Run button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const assetSections = data?.sections.filter((s) => s.side === "assets") ?? [];
  const liabilitySections =
    data?.sections.filter((s) => s.side === "liabilities") ?? [];

  const periodLabel =
    data?.periodLabel ?? (quarter === "All" ? `FY ${year}` : `${quarter} ${year}`);

  return (
    <div className="page">
      {/* period filter */}
      <div className="period-filter-bar">
        <div className="period-filter-fields">
          <div className="period-filter-group">
            <label className="period-filter-label" htmlFor="bs-year">
              Financial year
            </label>
            <select
              id="bs-year"
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
            <label className="period-filter-label" htmlFor="bs-quarter">
              Quarter
            </label>
            <select
              id="bs-quarter"
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
          onClick={() => fetchBalanceSheet(runId)}
          disabled={status === "loading"}
        >
          {status === "loading" ? "Running…" : "Run"}
        </button>

        <span className="run-card-id">run_id: {runId}</span>
      </div>

      {/* header */}
      <div className="page-header">
        <div>
          <h2>Balance Sheet</h2>
          <div className="sub">
            {periodLabel} · Accounting identity &amp; classification check
          </div>
        </div>

        {status === "ready" && data ? (
          <div className="header-actions">
            <span
              className={`badge ${
                data.identity.balanced ? "badge-green" : "badge-red"
              }`}
            >
              {data.identity.balanced ? "Identity verified" : "Identity failed"}
            </span>
            {data.warnings > 0 ? (
              <span className="badge badge-amber">
                {data.warnings} warning{data.warnings === 1 ? "" : "s"}
              </span>
            ) : (
              <span className="badge badge-green">No warnings</span>
            )}
          </div>
        ) : null}
      </div>

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
                onClick={() => fetchBalanceSheet(runId)}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {status === "idle" && (
          <div className="run-empty-state">
            <p>Pick a period and select Run to load the balance sheet.</p>
          </div>
        )}

        {status === "ready" && data && (
          <>
            <IdentityBar identity={data.identity} />

            {data.sections.length === 0 ? (
              <div className="empty-state">
                Run {runId} returned no balance sheet lines.
              </div>
            ) : (
              <div className="bs-split">
                <div>
                  <div className="bs-section-label">Assets</div>
                  {assetSections.map((s) => (
                    <SectionCard key={s.title} section={s} />
                  ))}
                </div>
                <div>
                  <div className="bs-section-label">Liabilities &amp; equity</div>
                  {liabilitySections.map((s) => (
                    <SectionCard key={s.title} section={s} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
