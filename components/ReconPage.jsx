"use client";

export default function ReconPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Reconciliation</h2>
          <div className="sub">
            Cross-document audit — P&amp;L · Balance Sheet · Receipts
          </div>
        </div>
        <div className="header-actions">
          <span className="badge badge-amber">3 Unmatched</span>
          <span className="badge badge-green">47 Matched</span>
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
        <div className="compile-bar">
          <div className="compile-info">
            <h4>Generate Unified Audit Report</h4>
            <p>
              Compiles all findings from P&amp;L, Balance Sheet, and Receipt
              modules into a single exportable PDF report.
            </p>
          </div>
          <button className="btn-compile">⬇ Compile Report</button>
        </div>

        <div className="kpi-row">
          <div className="kpi-card">
            <div className="kpi-label">Total Entries</div>
            <div className="kpi-value">50</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Matched</div>
            <div className="kpi-value text-green">47</div>
          </div>
          <div className="kpi-card warn">
            <div className="kpi-label">Unmatched</div>
            <div className="kpi-value text-amber">3</div>
          </div>
          <div className="kpi-card alert">
            <div className="kpi-label">Total Gap</div>
            <div className="kpi-value">$8,230</div>
            <div className="kpi-sub">Unreconciled amount</div>
          </div>
        </div>

        <div className="section-title">Cross-Document Matches</div>
        <div className="recon-flow">
          <div className="recon-row">
            <div className="recon-source">Receipt</div>
            <div className="recon-item">
              Delta Airlines — R-0044 · Business Travel
            </div>
            <div className="recon-amounts">
              <div>
                <div className="label">Receipt</div>$1,340
              </div>
              <div>
                <div className="label">P&amp;L Line</div>$1,340
              </div>
            </div>
            <div className="recon-result ok">✓ Matched</div>
          </div>
          <div className="recon-row">
            <div className="recon-source">Receipt</div>
            <div className="recon-item">
              AWS Cloud — R-0041 · IT Infrastructure
            </div>
            <div className="recon-amounts">
              <div>
                <div className="label">Receipt</div>$6,400
              </div>
              <div>
                <div className="label">P&amp;L Line</div>$6,400
              </div>
            </div>
            <div className="recon-result ok">✓ Matched</div>
          </div>
          <div className="recon-row mismatch">
            <div className="recon-source">Receipt</div>
            <div className="recon-item">
              TechSupplies Co — R-0047 · Equipment
            </div>
            <div className="recon-amounts">
              <div>
                <div className="label">Receipt</div>$4,200
              </div>
              <div>
                <div className="label">P&amp;L Line</div>None
              </div>
            </div>
            <div className="recon-result fail">✗ No P&amp;L match</div>
          </div>
          <div className="recon-row partial">
            <div className="recon-source">Receipt</div>
            <div className="recon-item">
              Office Depot (duplicate) — R-0031
            </div>
            <div className="recon-amounts">
              <div>
                <div className="label">Receipt</div>$820
              </div>
              <div>
                <div className="label">P&amp;L Line</div>$820 (R-0012)
              </div>
            </div>
            <div className="recon-result partial">⚠ Duplicate</div>
          </div>
          <div className="recon-row mismatch">
            <div className="recon-source">P&amp;L</div>
            <div className="recon-item">
              Marketing — unsubstantiated portion
            </div>
            <div className="recon-amounts">
              <div>
                <div className="label">P&amp;L</div>$340,000
              </div>
              <div>
                <div className="label">Receipts</div>$339,210
              </div>
            </div>
            <div className="recon-result fail">✗ Gap: $790</div>
          </div>
          <div className="recon-row">
            <div className="recon-source">Balance</div>
            <div className="recon-item">
              Accounts Payable ties to vendor invoices
            </div>
            <div className="recon-amounts">
              <div>
                <div className="label">BS</div>$218,000
              </div>
              <div>
                <div className="label">Invoices</div>$218,000
              </div>
            </div>
            <div className="recon-result ok">✓ Matched</div>
          </div>
        </div>

        <div className="module-card">
          <div className="module-card-header">
            <div className="module-card-title">Unified Findings Summary</div>
          </div>
          <div className="module-card-body">
            <div className="finding-item alert">
              <div className="finding-dot alert"></div>
              <div>
                <div className="finding-text">
                  <strong>
                    [CRITICAL] R-0047 appears forged and has no P&amp;L
                    match.
                  </strong>{" "}
                  The $4,200 receipt from TechSupplies Co. shows metadata
                  tampering AND does not correspond to any expense line item.
                  Recommend immediate escalation.
                </div>
                <div className="finding-meta">
                  CROSS-MODULE · P&amp;L + RECEIPTS · ESCALATE
                </div>
              </div>
            </div>
            <div className="finding-item warn">
              <div className="finding-dot warn"></div>
              <div>
                <div className="finding-text">
                  <strong>
                    [WARNING] Marketing expense has $790 receipt shortfall.
                  </strong>{" "}
                  P&amp;L records $340,000 but only $339,210 in substantiated
                  receipts. Request missing documentation.
                </div>
                <div className="finding-meta">
                  CROSS-MODULE · P&amp;L + RECEIPTS
                </div>
              </div>
            </div>
            <div className="finding-item warn">
              <div className="finding-dot warn"></div>
              <div>
                <div className="finding-text">
                  <strong>
                    [WARNING] Duplicate receipt inflates claimed expenses by
                    $820.
                  </strong>{" "}
                  R-0031 is a duplicate of R-0012. If both claimed, expense is
                  overstated.
                </div>
                <div className="finding-meta">CROSS-MODULE · RECEIPTS</div>
              </div>
            </div>
            <div className="finding-item warn">
              <div className="finding-dot warn"></div>
              <div>
                <div className="finding-text">
                  <strong>
                    [WARNING] Balance sheet A/R classification mismatch.
                  </strong>{" "}
                  $24,500 aged receivable should be reclassified to
                  non-current per GAAP. No P&amp;L impact but affects balance
                  sheet presentation.
                </div>
                <div className="finding-meta">BALANCE SHEET · GAAP</div>
              </div>
            </div>
            <div className="finding-item ok">
              <div className="finding-dot ok"></div>
              <div>
                <div className="finding-text">
                  <strong>[PASS] Accounting identity holds.</strong> Balance
                  sheet balances correctly at $2,847,320.
                </div>
                <div className="finding-meta">BALANCE SHEET · VERIFIED</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
