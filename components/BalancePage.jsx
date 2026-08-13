"use client";

/**
 * FinSightOps — Balance Sheet
 *
 * Drop in as: app/balance-sheet/page.jsx   (App Router)
 *          or pages/balance-sheet.jsx      (Pages Router — remove 'use client')
 *
 * Backend (Lambda → auditai-output DynamoDB scan, latest completed_at wins):
 *   POST <API_URL>
 *   Body:  { "financial_year": "2026", "quarter": "Q4" }
 *   Reply: { statusCode: 200, body: { balance_sheet_output, pnl_output, ... } }
 *          { statusCode: 400 | 404, body: "<message string>" }
 *
 * This page reads ONLY body.balance_sheet_output. Every other section of the
 * record (pnl_output, ledger_output, reconciliation_output …) is ignored.
 */

import { useState, useCallback, useMemo } from 'react';

/* ─── Constants ───────────────────────────────────────────── */

const API_URL =
  'https://j2aac6i6f0.execute-api.ap-southeast-1.amazonaws.com/default/finsight-upload-lookup-agent';

/** Selectable in the UI — the two params the Lambda accepts */
const FINANCIAL_YEARS = ['2024', '2025', '2026'];
const QUARTERS        = ['Q1', 'Q2', 'Q3', 'Q4'];

/* ─── Data helpers ────────────────────────────────────────── */

/** Peel the Lambda envelope: body may be an object, a JSON string, or plain text. */
function unwrapBody(raw) {
  let body = raw?.body ?? raw;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* plain-text message — leave as string */ }
  }
  return body;
}

/**
 * Pull the balance sheet out of the record and flatten it for rendering.
 * Throws a readable Error for every failure the backend can produce.
 */
function extractBalanceSheet(raw) {
  const code = raw?.statusCode;
  const body = unwrapBody(raw);

  if (typeof code === 'number' && code >= 400) {
    throw new Error(typeof body === 'string' ? body : `Request failed (${code})`);
  }
  if (typeof body === 'string' || !body || typeof body !== 'object') {
    throw new Error(String(body ?? 'Empty response from the audit service'));
  }

  const output = body.balance_sheet_output;
  if (!output) {
    throw new Error('This run has no balance sheet. The pipeline may still be in progress.');
  }

  const sheet = output.balance_sheet ?? {};

  return {
    runId:       output.run_id ?? body.run_id ?? '—',
    recordId:    body.run_id ?? null,             // run_id + unique suffix from DynamoDB
    completedAt: body.completed_at ?? null,
    /* Currency isn't carried on balance_sheet_output — borrow it for display only. */
    currency:    output.currency ?? body.ledger_output?.currency ?? '',
    status:      output.status ?? (sheet.is_balanced ? 'balanced' : 'unbalanced'),
    isBalanced:  sheet.is_balanced === true,
    assets:      sheet.assets      ?? {},
    liabilities: sheet.liabilities ?? {},
    equity:      sheet.equity      ?? {},
    totalAssets:      sheet.total_assets,
    totalLiabilities: sheet.total_liabilities,
    totalEquity:      sheet.total_equity,
    cash:             sheet.cash,
    imbalance:        sheet.imbalance,
    _sheet: output,
  };
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Accounting presentation: negatives in parentheses, always 2 dp. */
function money(v, currency = '') {
  const n = num(v);
  if (n === null) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const body = n < 0 ? `(${abs})` : abs;
  return currency ? `${currency} ${body}` : body;
}

const isNegative = (v) => (num(v) ?? 0) < 0;

/* ─── Sub-components ──────────────────────────────────────── */

/** One line item inside a balance-sheet section. */
function LineRow({ label, amount, currency, emphasis = false }) {
  return (
    <div className="recon-row">
      <div className="recon-item">
        <div style={{
          fontWeight: emphasis ? 700 : 600,
          color: emphasis ? 'var(--white)' : 'var(--slate-300)',
          fontSize: '0.85rem',
        }}>
          {label}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <div
        className="mono"
        style={{
          fontSize: emphasis ? '0.95rem' : '0.85rem',
          fontWeight: emphasis ? 700 : 500,
          color: isNegative(amount) ? 'var(--red-400)' : 'var(--white)',
          textAlign: 'right',
          minWidth: 160,
        }}
      >
        {money(amount, currency)}
      </div>
    </div>
  );
}

/** Assets / Liabilities / Equity block with its own subtotal. */
function SheetSection({ title, items, total, totalLabel, currency }) {
  const entries = Object.entries(items ?? {});

  return (
    <div className="module-card">
      <div className="module-card-header">
        <div className="module-card-title">{title}</div>
        <span className="mono" style={{ fontSize: '0.68rem', color: 'var(--slate-500)' }}>
          {entries.length} {entries.length === 1 ? 'account' : 'accounts'}
        </span>
      </div>
      <div className="module-card-body" style={{ padding: 0 }}>
        {entries.length === 0 ? (
          <div style={{ padding: '1rem 1.25rem', fontSize: '0.8rem', color: 'var(--slate-500)' }}>
            No accounts reported in this section.
          </div>
        ) : (
          <div className="recon-flow">
            {entries.map(([name, amount]) => (
              <LineRow key={name} label={name} amount={amount} currency={currency} />
            ))}
            <LineRow label={totalLabel} amount={total} currency={currency} emphasis />
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({ label, value, variant = 'neutral', mono = false }) {
  const extraClass = variant === 'warn' ? 'warn' : variant === 'alert' ? 'alert' : '';
  const valueColor =
    variant === 'ok'    ? 'var(--green-400)' :
    variant === 'warn'  ? 'var(--amber-400)' :
    variant === 'alert' ? 'var(--red-400)'   :
    'var(--white)';

  return (
    <div className={`kpi-card ${extraClass}`}>
      <div className="kpi-label">{label}</div>
      <div
        className="kpi-value"
        style={{
          color: valueColor,
          fontFamily: mono ? 'var(--font-mono, "IBM Plex Mono", monospace)' : undefined,
          fontSize: '1.5rem',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Skeleton({ h = 60, radius = 6 }) {
  return (
    <div
      style={{
        height: h,
        borderRadius: radius,
        background: 'linear-gradient(90deg, #1e293b 25%, #273548 50%, #1e293b 75%)',
        backgroundSize: '200% 100%',
        animation: 'auditShimmer 1.4s infinite',
      }}
    />
  );
}

function LoadingState() {
  return (
    <div className="dashboard-body">
      <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="kpi-card">
            <Skeleton h={18} radius={4} />
            <div style={{ marginTop: 10 }}><Skeleton h={30} radius={4} /></div>
          </div>
        ))}
      </div>
      <Skeleton h={72} />
      {[0, 1, 2].map(i => <Skeleton key={i} h={190} />)}
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────── */

export default function BalanceSheetPage() {
  const [financialYear, setFinancialYear] = useState('2026');
  const [quarter,       setQuarter]       = useState('Q4');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [sheet,   setSheet]   = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  const loadBalanceSheet = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setSheet(null);
    setShowRaw(false);

    try {
      const res = await fetch(API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ financial_year: financialYear, quarter }),
      });

      const raw = await res.json().catch(() => null);
      if (!raw) throw new Error(`The service returned a non-JSON response (HTTP ${res.status}).`);
      if (!res.ok && !raw.statusCode) {
        throw new Error(raw?.message ?? raw?.error ?? `HTTP ${res.status} — ${res.statusText}`);
      }

      setSheet(extractBalanceSheet(raw));
    } catch (err) {
      setError(err.message ?? 'Something went wrong loading the balance sheet.');
    } finally {
      setLoading(false);
    }
  }, [financialYear, quarter, loading]);

  /* Accounting identity: assets vs liabilities + equity */
  const identity = useMemo(() => {
    if (!sheet) return null;
    const assets = num(sheet.totalAssets) ?? 0;
    const liabs  = num(sheet.totalLiabilities) ?? 0;
    const equity = num(sheet.totalEquity) ?? 0;
    const diff   = num(sheet.imbalance) ?? (assets - (liabs + equity));
    return {
      left: assets,
      right: liabs + equity,
      difference: diff,
      passes: sheet.isBalanced && Math.abs(diff) < 0.005,
    };
  }, [sheet]);

  const cur = sheet?.currency ?? '';

  return (
    <>
      <style>{`
        @keyframes auditShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes spin__bs { to { transform: rotate(360deg); } }
        .bs-select {
          background: var(--slate-800);
          border: 1px solid var(--slate-700);
          border-radius: 4px;
          color: var(--white);
          font-size: 0.82rem;
          font-family: 'IBM Plex Mono', monospace;
          padding: 0.4rem 0.7rem;
          min-width: 110px;
          outline: none;
          cursor: pointer;
          color-scheme: dark;
          transition: border-color 0.15s;
        }
        .bs-select:focus  { border-color: var(--amber-400); }
        .bs-select:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>

      <div className="page">

        {/* ── Period bar ───────────────────────────────────── */}
        <div className="period-filter-bar">
          <div className="period-filter-group">
            <span className="period-filter-label">Financial year</span>
            <select
              className="bs-select"
              value={financialYear}
              onChange={e => setFinancialYear(e.target.value)}
              disabled={loading}
              aria-label="Financial year"
            >
              {FINANCIAL_YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          <div className="period-filter-group">
            <span className="period-filter-label">Quarter</span>
            <select
              className="bs-select"
              value={quarter}
              onChange={e => setQuarter(e.target.value)}
              disabled={loading}
              aria-label="Quarter"
            >
              {QUARTERS.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>

          <button
            className="btn-compile period-filter-run"
            onClick={loadBalanceSheet}
            disabled={loading}
            style={{ opacity: loading ? 0.5 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            {loading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{
                  display: 'inline-block', width: 13, height: 13,
                  border: '2px solid rgba(10,15,26,0.3)',
                  borderTopColor: 'var(--slate-950)',
                  borderRadius: '50%',
                  animation: 'spin__bs 0.7s linear infinite',
                }} />
                Loading…
              </span>
            ) : '▶ Load balance sheet'}
          </button>

          <div style={{ flex: 1 }} />

          {sheet && !loading && (
            <button className="run-details-btn" onClick={() => setShowRaw(v => !v)}>
              {showRaw ? 'Hide raw JSON' : 'View raw JSON'}
            </button>
          )}
        </div>

        {/* ── Error ────────────────────────────────────────── */}
        {error && (
          <div style={{ padding: '0 2rem' }}>
            <div className="run-error-banner" style={{ marginTop: '1.5rem' }}>
              <strong>Could not load {financialYear}-{quarter} —</strong> {error}
            </div>
          </div>
        )}

        {/* ── Raw JSON (balance_sheet_output only) ─────────── */}
        {showRaw && sheet && (
          <div style={{ padding: '1rem 2rem 0' }}>
            <div
              className="module-card"
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '0.75rem',
                color: 'var(--slate-400)',
                padding: '1.25rem',
                whiteSpace: 'pre',
                overflowX: 'auto',
                maxHeight: 360,
                overflowY: 'auto',
                lineHeight: 1.6,
              }}
            >
              {JSON.stringify(sheet._sheet, null, 2)}
            </div>
          </div>
        )}

        {loading && <LoadingState />}

        {/* ── Empty ────────────────────────────────────────── */}
        {!loading && !sheet && !error && (
          <div className="empty-state" style={{ paddingTop: '5rem' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '1rem', opacity: 0.3 }}>⚖️</div>
            <div style={{ color: 'var(--slate-300)', fontWeight: 600, marginBottom: '0.5rem' }}>
              Pick a period to begin
            </div>
            <div>
              Choose a financial year and quarter, then click{' '}
              <strong style={{ color: 'var(--amber-400)' }}>Load balance sheet</strong>.
              The most recent run for that period is shown.
            </div>
          </div>
        )}

        {/* ── Results ──────────────────────────────────────── */}
        {!loading && sheet && (
          <>
            <div className="page-header">
              <div>
                <h2>Balance Sheet</h2>
                <div className="sub mono">
                  {sheet.runId}
                  {sheet.completedAt && ` · run completed ${new Date(sheet.completedAt).toLocaleString(undefined, {
                    dateStyle: 'medium', timeStyle: 'short',
                  })}`}
                </div>
              </div>
              <div className="header-actions">
                <span className={`badge ${sheet.isBalanced ? 'badge-green' : 'badge-red'}`}>
                  {sheet.isBalanced ? 'Balanced' : 'Out of balance'}
                </span>
                {cur && <span className="badge badge-amber">{cur}</span>}
              </div>
            </div>

            <div className="dashboard-body">

              <div className="kpi-row">
                <KpiCard
                  label="Total assets"
                  value={money(sheet.totalAssets, cur)}
                  variant={isNegative(sheet.totalAssets) ? 'alert' : 'neutral'}
                  mono
                />
                <KpiCard label="Total liabilities" value={money(sheet.totalLiabilities, cur)} mono />
                <KpiCard
                  label="Total equity"
                  value={money(sheet.totalEquity, cur)}
                  variant={isNegative(sheet.totalEquity) ? 'alert' : 'neutral'}
                  mono
                />
                <KpiCard
                  label="Imbalance"
                  value={money(sheet.imbalance, cur)}
                  variant={sheet.isBalanced ? 'ok' : 'alert'}
                  mono
                />
              </div>

              {/* Accounting identity check */}
              {identity && (
                <div className={`recon-row ${identity.passes ? '' : 'mismatch'}`}>
                  <div className="recon-source" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: identity.passes ? 'var(--green-500)' : 'var(--red-500)',
                      display: 'inline-block',
                    }} />
                    <span style={{ fontSize: '0.65rem', lineHeight: 1 }}>
                      {identity.passes ? 'PASS' : 'FAIL'}
                    </span>
                  </div>
                  <div className="recon-item">
                    <div style={{ fontWeight: 600, color: 'var(--white)', fontSize: '0.85rem' }}>
                      Assets = Liabilities + Equity
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--slate-500)', marginTop: '0.2rem' }}>
                      Everything the business owns was funded either by borrowing or by the owners,
                      so the two sides must agree.
                    </div>
                  </div>
                  <div className="recon-amounts">
                    <div>
                      <div className="label">assets</div>
                      <div>{money(identity.left, cur)}</div>
                    </div>
                    <div>
                      <div className="label">liabilities + equity</div>
                      <div>{money(identity.right, cur)}</div>
                    </div>
                  </div>
                  <div className={`recon-result ${identity.passes ? 'ok' : 'fail'}`}>
                    {identity.passes ? '✓ PASS' : `✗ ${money(identity.difference, cur)}`}
                  </div>
                </div>
              )}

              <SheetSection
                title="Assets"
                items={sheet.assets}
                total={sheet.totalAssets}
                totalLabel="Total assets"
                currency={cur}
              />
              <SheetSection
                title="Liabilities"
                items={sheet.liabilities}
                total={sheet.totalLiabilities}
                totalLabel="Total liabilities"
                currency={cur}
              />
              <SheetSection
                title="Equity"
                items={sheet.equity}
                total={sheet.totalEquity}
                totalLabel="Total equity"
                currency={cur}
              />

              {isNegative(sheet.cash) && (
                <div className="run-error-banner">
                  <strong>Cash is overdrawn —</strong> the ledger shows {money(sheet.cash, cur)} in cash.
                  Confirm against a bank statement before signing off.
                </div>
              )}

              {sheet.recordId && (
                <div className="mono" style={{ fontSize: '0.68rem', color: 'var(--slate-600)', textAlign: 'right' }}>
                  record {sheet.recordId}
                </div>
              )}

            </div>
          </>
        )}
      </div>
    </>
  );
}
