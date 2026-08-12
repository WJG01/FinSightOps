"use client";

export default function LandingPage({ showPage }) {
  return (
    <div className="hero">
      <div className="hero-eyebrow">Agentic AI Finance Auditing</div>
      <h1>
        Every figure.
        <br />
        <em>Verified.</em> Every anomaly.
        <br />
        Flagged.
      </h1>
      <p className="hero-sub">
        AuditAI runs end-to-end forensic analysis across your P&amp;L
        statements, balance sheets, and receipts — then reconciles everything
        into a single unified finding.
      </p>
      <div className="hero-actions">
        <button className="btn-primary" onClick={() => showPage("summary")}>
          Open Summary
        </button>
        <button className="btn-ghost" onClick={() => showPage("recon")}>
          View Reconciliation
        </button>
      </div>
      <div className="feature-grid">
        <div className="feature-card" onClick={() => showPage("upload")}>
          <div className="feature-icon">📤</div>
          <h3>Upload Doc</h3>
          <p>Upload your raw documents here.</p>
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
          <p>Final Consolidated Summary Finding</p>
        </div>
        {/* <div className="feature-card" onClick={() => showPage("receipts")}>
          <div className="feature-icon">🧾</div>
          <h3>Receipt Authenticity</h3>
          <p>
            Detects forgeries, visual tampering, and duplicate submissions via
            metadata and AI analysis.
          </p>
        </div> */}
      </div>
    </div>
  );
}
