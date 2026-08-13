"use client";

/**
 * FinSightOps — Reconciliation Page
 *
 * Uses the global app CSS (no module import needed).
 * Drop in as: app/reconciliation/page.jsx  (App Router)
 *          or pages/reconciliation.jsx      (Pages Router — remove 'use client')
 *
 * API: POST https://aeg0uq46dk.execute-api.ap-southeast-1.amazonaws.com/default/finsight-reconciliation-agent
 *      Body: { "run_id": "<string>" }
 */

import { useState, useCallback } from 'react';

/* ─── Constants ───────────────────────────────────────────── */
const API_URL =
  'https://aeg0uq46dk.execute-api.ap-southeast-1.amazonaws.com/default/finsight-reconciliation-agent';

/* ─── Data helpers ────────────────────────────────────────── */

/**
 * Normalise the Lambda/API Gateway response into a predictable shape.
 * Handles three common response wrappers:
 *   1. Raw object           → { checks, summary, narrative, … }
 *   2. { body: "string" }  → JSON-parse the string
 *   3. { body: object }    → unwrap the object
 */
function normalise(raw) {
  let data = raw;
  if (typeof data?.body === 'string') {
    try { data = JSON.parse(data.body); } catch { /* keep raw */ }
  } else if (data?.body && typeof data.body === 'object') {
    data = data.body;
  }

  const checks  = data?.checks  ?? data?.results ?? [];
  const summary = data?.summary ?? buildSummary(checks);

  return {
    run_id:      data?.run_id      ?? data?.runId     ?? '—',
    status:      data?.status                         ?? deriveStatus(summary),
    summary,
    checks,
    narrative:   data?.narrative   ?? data?.reasoning ?? data?.explanation ?? null,
    model:       data?.model       ?? data?.model_id  ?? null,
    generatedAt: data?.generated_at ?? data?.timestamp ?? new Date().toISOString(),
    _raw: raw,
  };
}

function buildSummary(checks) {
  const passed  = checks.filter(c => getStatus(c) === 'PASS').length;
  const skipped = checks.filter(c => getStatus(c) === 'SKIPPED').length;
  const failed  = checks.filter(c => getStatus(c) === 'FAIL').length;
  return { total: checks.length, passed, skipped, failed };
}

function deriveStatus({ failed = 0, total = 0 } = {}) {
  if (!total) return 'UNKNOWN';
  return failed > 0 ? 'FAIL' : 'PASS';
}

/** Normalise status string regardless of casing or aliases */
function getStatus(check) {
  const s = (check?.status ?? check?.result ?? '').toUpperCase();
  if (['PASS', 'PASSED', 'OK'].includes(s))           return 'PASS';
  if (['SKIP', 'SKIPPED', 'N/A'].includes(s))         return 'SKIPPED';
  if (['FAIL', 'FAILED', 'ERROR'].includes(s))        return 'FAIL';
  return s || 'UNKNOWN';
}

/** Extract up to N key-value pairs from a check's values/data/details field */
function valueEntries(check, max = 2) {
  const src = check?.values ?? check?.data ?? check?.details ?? null;
  if (!src || typeof src !== 'object') return [];
  return Object.entries(src)
    .filter(([, v]) => v !== null && v !== undefined)
    .slice(0, max);
}

function fmt(v) {
  if (typeof v === 'number')
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(v);
}

/* ─── Sub-components ──────────────────────────────────────── */

/** A single tie-out check row using the existing .recon-row classes */
function CheckRow({ check }) {
  const status   = getStatus(check);
  const isSkip   = status === 'SKIPPED';
  const isFail   = status === 'FAIL';
  const entries  = valueEntries(check);

  // Map status → existing CSS modifier class
  const rowMod    = isFail ? 'mismatch' : isSkip ? 'partial' : '';
  const resultMod = isFail ? 'fail'     : isSkip ? 'partial' : 'ok';
  const label     = status === 'PASS' ? '✓ PASS' : status === 'FAIL' ? '✗ FAIL' : 'SKIPPED';

  const skipNote =
    check?.skip_reason ?? check?.reason ?? check?.note ?? null;

  return (
    <div className={`recon-row ${rowMod}`}>

      {/* Status icon column — reusing .recon-source width */}
      <div className="recon-source" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: isFail ? 'var(--red-500)' : isSkip ? 'var(--slate-600)' : 'var(--green-500)',
          display: 'inline-block',
        }} />
        <span style={{ fontSize: '0.65rem', lineHeight: 1 }}>
          {status}
        </span>
      </div>

      {/* Check name + explanation */}
      <div className="recon-item">
        <div style={{ fontWeight: 600, color: 'var(--white)', fontSize: '0.85rem' }}>
          {check.name ?? check.check_name ?? check.id ?? 'Unnamed check'}
        </div>
        {check.explanation && (
          <div style={{ fontSize: '0.72rem', color: 'var(--slate-500)', marginTop: '0.2rem' }}>
            {check.explanation}
          </div>
        )}
        {isSkip && skipNote && (
          <div style={{ fontSize: '0.72rem', color: 'var(--slate-500)', fontStyle: 'italic', marginTop: '0.2rem' }}>
            {skipNote}
          </div>
        )}
      </div>

      {/* Value columns — only for non-skipped checks */}
      {!isSkip && entries.length > 0 ? (
        <div className="recon-amounts">
          {entries.map(([k, v]) => (
            <div key={k}>
              <div className="label">{k}</div>
              <div>{fmt(v)}</div>
            </div>
          ))}
        </div>
      ) : (
        /* Keep grid shape for skipped rows */
        <div style={{ flex: 1 }} />
      )}

      {/* Result pill */}
      <div className={`recon-result ${resultMod}`}>
        {label}
      </div>
    </div>
  );
}

/** KPI card with left-border colour driven by context */
function KpiCard({ label, value, variant = 'ok', mono = false }) {
  // variant: 'ok' | 'warn' | 'alert' | 'neutral'
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
          fontSize: '1.75rem',
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** Skeleton shimmer — inline so no extra class needed */
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

/** Loading state — reuses existing card chrome */
function LoadingState() {
  return (
    <div className="dashboard-body">
      {/* KPI skeleton */}
      <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="kpi-card">
            <Skeleton h={18} radius={4} />
            <div style={{ marginTop: 10 }}>
              <Skeleton h={32} radius={4} />
            </div>
          </div>
        ))}
      </div>

      {/* Check rows skeleton */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {[0, 1, 2, 3, 4].map(i => (
          <Skeleton key={i} h={64} />
        ))}
      </div>

      {/* Narrative skeleton */}
      <Skeleton h={180} />
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────── */
export default function ReconciliationPage() {
  const [runId,   setRunId]   = useState('2026-Q1');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [result,  setResult]  = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  const runAnalysis = useCallback(async () => {
    if (!runId.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setShowRaw(false);

    try {
      const res = await fetch(API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ run_id: runId.trim() }),
      });

      const raw = await res.json().catch(() => ({ _raw: 'Non-JSON response' }));

      if (!res.ok) {
        throw new Error(
          raw?.message ?? raw?.error ?? `HTTP ${res.status} — ${res.statusText}`
        );
      }

      setResult(normalise(raw));
    } catch (err) {
      setError(err.message ?? 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [runId, loading]);

  const handleKey = (e) => { if (e.key === 'Enter') runAnalysis(); };

  /* Derived values */
  const { summary, checks = [], status, narrative, model, generatedAt, _raw } = result ?? {};
  const passed  = summary?.passed  ?? 0;
  const skipped = summary?.skipped ?? 0;
  const failed  = summary?.failed  ?? 0;
  const total   = summary?.total   ?? 0;

  const overallVariant =
    status === 'PASS' ? 'ok' : status === 'FAIL' ? 'alert' : 'warn';

  return (
    <>
      {/* Shimmer keyframe — injected once, no extra file needed */}
      <style>{`
        @keyframes auditShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .recon-run-input {
          background: var(--slate-800);
          border: 1px solid var(--slate-700);
          border-radius: 4px;
          color: var(--white);
          font-size: 0.82rem;
          font-family: 'IBM Plex Mono', monospace;
          padding: 0.4rem 0.7rem;
          width: 200px;
          outline: none;
          transition: border-color 0.15s;
        }
        .recon-run-input:focus { border-color: var(--amber-400); }
        .recon-run-input:disabled { opacity: 0.5; cursor: not-allowed; }
        .recon-run-input::placeholder { color: var(--slate-600); }
      `}</style>

      <div className="page">

        {/* ── Run bar ─────────────────────────────────────── */}
        <div className="period-filter-bar">
          <div className="period-filter-group">
            <span className="period-filter-label">Run ID</span>
            <input
              className="recon-run-input"
              type="text"
              value={runId}
              onChange={e => setRunId(e.target.value)}
              onKeyDown={handleKey}
              placeholder="e.g. 2026-Q1"
              disabled={loading}
              aria-label="Run ID"
            />
          </div>

          <button
            className="btn-compile period-filter-run"
            onClick={runAnalysis}
            disabled={loading || !runId.trim()}
            style={{ opacity: (loading || !runId.trim()) ? 0.5 : 1, cursor: (loading || !runId.trim()) ? 'not-allowed' : 'pointer' }}
          >
            {loading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{
                  display: 'inline-block', width: 13, height: 13,
                  border: '2px solid rgba(10,15,26,0.3)',
                  borderTopColor: 'var(--slate-950)',
                  borderRadius: '50%', animation: 'auditShimmer 0.7s linear infinite',
                  // override shimmer for spinner
                  backgroundImage: 'none', background: 'none',
                  animationName: 'spin__recon',
                }} />
                Analysing…
                <style>{`@keyframes spin__recon { to { transform: rotate(360deg); } }`}</style>
              </span>
            ) : '▶ Run Analysis'}
          </button>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Raw JSON toggle — visible once we have a result */}
          {result && !loading && (
            <button
              className="run-details-btn"
              onClick={() => setShowRaw(v => !v)}
            >
              {showRaw ? 'Hide raw JSON' : 'View raw JSON'}
            </button>
          )}
        </div>

        {/* ── Error banner ─────────────────────────────────── */}
        {error && (
          <div style={{ padding: '0 2rem' }}>
            <div className="run-error-banner" style={{ marginTop: '1.5rem' }}>
              <strong>Agent returned an error —</strong> {error}
            </div>
          </div>
        )}

        {/* ── Raw JSON panel ───────────────────────────────── */}
        {showRaw && _raw && (
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
              {JSON.stringify(_raw, null, 2)}
            </div>
          </div>
        )}

        {/* ── Loading skeleton ──────────────────────────────── */}
        {loading && <LoadingState />}

        {/* ── Empty state ───────────────────────────────────── */}
        {!loading && !result && !error && (
          <div className="empty-state" style={{ paddingTop: '5rem' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '1rem', opacity: 0.3 }}>⚖️</div>
            <div style={{ color: 'var(--slate-300)', fontWeight: 600, marginBottom: '0.5rem' }}>
              No audit results yet
            </div>
            <div>
              Enter a Run ID above and click{' '}
              <strong style={{ color: 'var(--amber-400)' }}>Run Analysis</strong>{' '}
              to kick off the reconciliation agent.
            </div>
          </div>
        )}

        {/* ── Results ───────────────────────────────────────── */}
        {!loading && result && (
          <>
            {/* Page header */}
            <div className="page-header">
              <div>
                <h2>Reconciliation</h2>
                <div className="sub mono">
                  run_id: {result.run_id} · Cross-document tie-out audit
                </div>
              </div>
              <div className="header-actions">
                {passed  > 0 && <span className="badge badge-green">{passed} Passed</span>}
                {skipped > 0 && <span className="badge badge-amber">{skipped} Skipped</span>}
                {failed  > 0 && <span className="badge badge-red">{failed} Failed</span>}
              </div>
            </div>

            <div className="dashboard-body">

              {/* ── KPI row ────────────────────────────────── */}
              <div className="kpi-row">
                <KpiCard label="Total checks"  value={total}   variant="neutral" />
                <KpiCard label="Passed"         value={passed}  variant="ok"      />
                <KpiCard label="Skipped"        value={skipped} variant="warn"    />
                <KpiCard label="Overall status" value={status ?? '—'} variant={overallVariant} mono />
              </div>

              {/* ── Tie-out checks ─────────────────────────── */}
              {checks.length > 0 && (
                <>
                  <div style={{
                    fontSize: '0.72rem', textTransform: 'uppercase',
                    letterSpacing: '0.08em', color: 'var(--slate-400)',
                    fontWeight: 500,
                  }}>
                    Tie-out checks
                  </div>
                  <div className="recon-flow">
                    {checks.map((check, i) => (
                      <CheckRow key={check.id ?? check.check_id ?? i} check={check} />
                    ))}
                  </div>
                </>
              )}

              {/* ── AI narrative ───────────────────────────── */}
              {narrative && (
                <>
                  <div style={{
                    fontSize: '0.72rem', textTransform: 'uppercase',
                    letterSpacing: '0.08em', color: 'var(--slate-400)',
                    fontWeight: 500,
                  }}>
                    AI reasoning
                  </div>
                  <div className="module-card">
                    <div className="module-card-header">
                      <div className="module-card-title">
                        {/* Status dot */}
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: status === 'FAIL' ? 'var(--red-500)' : 'var(--green-500)',
                          display: 'inline-block',
                        }} />
                        Reconciliation narrative
                        <span className={`badge ${
                          status === 'PASS' ? 'badge-green' :
                          status === 'FAIL' ? 'badge-red'   : 'badge-amber'
                        }`}>
                          {status ?? 'UNKNOWN'}
                        </span>
                      </div>
                      {model && (
                        <span className="mono" style={{ fontSize: '0.68rem', color: 'var(--slate-500)' }}>
                          {model}
                        </span>
                      )}
                    </div>
                    <div className="module-card-body">
                      {/* Split narrative on blank lines into paragraphs */}
                      {narrative.split(/\n{2,}/).filter(Boolean).map((para, i) => (
                        <p key={i} style={{ marginBottom: '0.9rem', lineHeight: 1.75, fontSize: '0.85rem', color: 'var(--slate-300)' }}>
                          {para.trim()}
                        </p>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* ── Compile / next-step bar ─────────────────── */}
              {status === 'PASS' && (
                <div className="compile-bar">
                  <div className="compile-info">
                    <h4>Reconciliation complete</h4>
                    <p>All tie-out checks passed. You can now generate the final audit report.</p>
                  </div>
                  <button className="btn-compile">Generate Audit Report →</button>
                </div>
              )}

              {/* Timestamp footer */}
              {generatedAt && (
                <div className="mono" style={{ fontSize: '0.68rem', color: 'var(--slate-600)', textAlign: 'right' }}>
                  Generated {new Date(generatedAt).toLocaleString(undefined, {
                    dateStyle: 'medium', timeStyle: 'short',
                  })}
                </div>
              )}

            </div>
          </>
        )}
      </div>
    </>
  );
}
