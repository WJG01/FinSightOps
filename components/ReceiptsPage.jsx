"use client";

const RECEIPTS = [
  {
    vendor: "TechSupplies Co.",
    amount: "$4,200.00 · R-0047",
    check: "Metadata mismatch · JPEG artifacts · High risk",
    cardClass: "forged",
    flagClass: "fail",
    flagLabel: "FORGED",
  },
  {
    vendor: "Office Depot",
    amount: "$820.00 · R-0031",
    check: "Matches R-0012 — submitted twice",
    cardClass: "flagged",
    flagClass: "warn",
    flagLabel: "DUPLICATE",
  },
  {
    vendor: "Office Depot",
    amount: "$820.00 · R-0012",
    check: "Original — duplicate detected in R-0031",
    cardClass: "flagged",
    flagClass: "warn",
    flagLabel: "DUPLICATE",
  },
  {
    vendor: "Delta Airlines",
    amount: "$1,340.00 · R-0044",
    check: "All checks passed",
    cardClass: "",
    flagClass: "ok",
    flagLabel: "CLEAN",
  },
  {
    vendor: "Marriott Hotels",
    amount: "$2,100.00 · R-0039",
    check: "All checks passed",
    cardClass: "",
    flagClass: "ok",
    flagLabel: "CLEAN",
  },
  {
    vendor: "AWS Cloud",
    amount: "$6,400.00 · R-0041",
    check: "All checks passed",
    cardClass: "",
    flagClass: "ok",
    flagLabel: "CLEAN",
  },
  {
    vendor: "Salesforce",
    amount: "$3,200.00 · R-0038",
    check: "All checks passed",
    cardClass: "",
    flagClass: "ok",
    flagLabel: "CLEAN",
  },
  {
    vendor: "FedEx Shipping",
    amount: "$310.00 · R-0036",
    check: "All checks passed",
    cardClass: "",
    flagClass: "ok",
    flagLabel: "CLEAN",
  },
];

export default function ReceiptsPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Receipt Authenticity</h2>
          <div className="sub">
            50 receipts analysed · Metadata, visual &amp; duplicate checks
          </div>
        </div>
        <div className="header-actions">
          <span className="badge badge-red">1 Suspected Forgery</span>
          <span className="badge badge-amber">2 Duplicates Flagged</span>
        </div>
      </div>

      <div
        style={{
          padding: "2rem",
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        <div className="upload-zone">
          <div className="upload-icon">📎</div>
          <p>Drop receipts here or click to upload — PDF, JPG, PNG accepted</p>
        </div>

        <div className="kpi-row">
          <div className="kpi-card alert">
            <div className="kpi-label">Suspected Forgery</div>
            <div className="kpi-value">1</div>
          </div>
          <div className="kpi-card warn">
            <div className="kpi-label">Duplicates</div>
            <div className="kpi-value">2</div>
          </div>
          <div className="kpi-card warn">
            <div className="kpi-label">Metadata Mismatch</div>
            <div className="kpi-value">3</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Verified Clean</div>
            <div className="kpi-value">44</div>
            <div className="kpi-sub up">88%</div>
          </div>
        </div>

        <div className="section-title">All Receipts</div>
        <div className="receipt-grid">
          {RECEIPTS.map((r, i) => (
            <div
              className={`receipt-card ${r.cardClass}`.trim()}
              key={`${r.vendor}-${i}`}
            >
              <div className="receipt-thumb">
                🧾
                <span className={`receipt-flag ${r.flagClass}`}>
                  {r.flagLabel}
                </span>
              </div>
              <div className="receipt-info">
                <div className="receipt-vendor">{r.vendor}</div>
                <div className="receipt-amount">{r.amount}</div>
                <div className="receipt-check">{r.check}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="module-card">
          <div className="module-card-header">
            <div className="module-card-title">Detection Methods</div>
          </div>
          <div className="module-card-body">
            <div className="bar-chart">
              <div className="bar-row">
                <div className="bar-label">Metadata</div>
                <div className="bar-track">
                  <div className="bar-fill green" style={{ width: "100%" }}></div>
                </div>
                <div className="bar-value">50/50</div>
              </div>
              <div className="bar-row">
                <div className="bar-label">Visual AI</div>
                <div className="bar-track">
                  <div className="bar-fill green" style={{ width: "100%" }}></div>
                </div>
                <div className="bar-value">50/50</div>
              </div>
              <div className="bar-row">
                <div className="bar-label">Hash Dedupe</div>
                <div className="bar-track">
                  <div className="bar-fill green" style={{ width: "100%" }}></div>
                </div>
                <div className="bar-value">50/50</div>
              </div>
              <div className="bar-row">
                <div className="bar-label">Vendor DB</div>
                <div className="bar-track">
                  <div className="bar-fill amber" style={{ width: "84%" }}></div>
                </div>
                <div className="bar-value">42/50</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
