"use client";

export default function LandingPage({ showPage }) {
  return (
    <div className="hero">
      <div className="hero-eyebrow">Agentic AI Finance Auditing</div>
      <h1>
        Every figure.
        <br />
        <em>Verified.</em> Every insight.
        <br />
        Captured.
      </h1>
      <p className="hero-sub">
        FinSightOps runs end-to-end financial audit analysis across your P&amp;L
        statements, balance sheets, and receipts — then reconciles everything
        into a single unified finding.
      </p>
      <div className="hero-actions">
        <button className="btn-primary" onClick={() => showPage("upload")}>
          Begin by Upload
        </button>
        <button className="btn-ghost" onClick={() => showPage("summary")}>
          View Summary
        </button>
      </div>
      <div className="feature-grid">
        <div className="feature-card" onClick={() => showPage("upload")}>
          <div className="feature-icon">📤</div>
          <h3>Upload Doc</h3>
          <p>
            Ingests raw receipts and statements, then routes them into the audit
            pipeline for processing.
          </p>
        </div>
        <div className="feature-card" onClick={() => showPage("upload")}>
          <div className="feature-icon">🔄</div>
          <h3>Run Progress</h3>
          <p>
            Tracks each agent stage in real time, from ingestion through
            reconciliation, with live status.
          </p>
        </div>
        <div className="feature-card" onClick={() => showPage("pl")}>
          <div className="feature-icon">📊</div>
          <h3>P&amp;L Analysis</h3>
          <p>
            Reads statements, computes margins, detects line items that deviate
            from historical baselines.
          </p>
        </div>
        <div className="feature-card" onClick={() => showPage("balance")}>
          <div className="feature-icon">⚖️</div>
          <h3>Balance Sheet</h3>
          <p>
            Verifies the accounting identity, checks totals foot correctly, and
            spots misclassified entries.
          </p>
        </div>
        <div className="feature-card" onClick={() => showPage("recon")}>
          <div className="feature-icon">🔍</div>
          <h3>Reconciliation</h3>
          <p>
            Cross-checks all three sources, ensures receipts tie to P&amp;L
            expenses, compiles unified findings.
          </p>
        </div>
        <div className="feature-card" onClick={() => showPage("recon")}>
          <div className="feature-icon">📋</div>
          <h3>Summary</h3>
          <p>
            Rolls up every stage's findings into one consolidated report with
            final audit conclusions.
          </p>
        </div>
      </div>
    </div>
  );
}
