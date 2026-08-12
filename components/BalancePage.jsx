"use client";

import { useState } from "react";
import PeriodSelector, { FINANCIAL_YEARS } from "./PeriodSelector";

export default function BalancePage() {
  const [financialYear, setFinancialYear] = useState(FINANCIAL_YEARS[0]);
  const [quarter, setQuarter] = useState("all");
  return (
    <div>
      <PeriodSelector
        financialYear={financialYear}
        quarter={quarter}
        onFinancialYearChange={setFinancialYear}
        onQuarterChange={setQuarter}
        onRun={() => console.log("Run clicked", { financialYear, quarter })}
      />
      <div className="page-header">
        <div>
          <h2>Balance Sheet</h2>
          <div className="sub">
            Q3 2024 · Accounting identity &amp; classification check
          </div>
        </div>
        <div className="header-actions">
          <span className="badge badge-green">Identity Verified</span>
          <span className="badge badge-amber">1 Warning</span>
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
        {/* Identity verification bar */}
        <div className="bs-verify-bar">
          <div>
            <div className="bs-verify-label">Accounting Identity Check</div>
            <div className="bs-verify-eq mono" style={{ marginTop: "0.35rem" }}>
              $2,847,320 = $1,102,480 + $1,744,840
            </div>
          </div>
          <div className="bs-verify-status text-green">
            ✓ &nbsp;<span>Balanced</span>
          </div>
        </div>

        <div className="bs-split">
          {/* Assets */}
          <div>
            <div className="bs-section-label">Assets</div>
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">Current Assets</div>
                <span className="badge badge-green">$1,294,200</span>
              </div>
              <div className="module-card-body" style={{ padding: 0 }}>
                <table className="pl-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Cash &amp; Equivalents</td>
                      <td className="num">$487,000</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                    <tr className="flagged">
                      <td>Accounts Receivable</td>
                      <td className="num">$324,500</td>
                      <td>
                        <span className="badge badge-amber">⚠ Review</span>
                      </td>
                    </tr>
                    <tr>
                      <td>Inventory</td>
                      <td className="num">$402,700</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                    <tr>
                      <td>Prepaid Expenses</td>
                      <td className="num">$80,000</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ height: "1rem" }}></div>
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">Non-Current Assets</div>
                <span className="badge badge-green">$1,553,120</span>
              </div>
              <div className="module-card-body" style={{ padding: 0 }}>
                <table className="pl-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Property &amp; Equipment</td>
                      <td className="num">$980,000</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                    <tr>
                      <td>Intangible Assets</td>
                      <td className="num">$430,000</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                    <tr>
                      <td>Long-term Investments</td>
                      <td className="num">$143,120</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Liabilities + Equity */}
          <div>
            <div className="bs-section-label">Liabilities &amp; Equity</div>
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">Current Liabilities</div>
                <span className="badge badge-green">$502,480</span>
              </div>
              <div className="module-card-body" style={{ padding: 0 }}>
                <table className="pl-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Accounts Payable</td>
                      <td className="num">$218,000</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                    <tr>
                      <td>Short-term Debt</td>
                      <td className="num">$150,000</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                    <tr>
                      <td>Accrued Liabilities</td>
                      <td className="num">$134,480</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ height: "1rem" }}></div>
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">Non-Current Liabilities</div>
                <span className="badge badge-green">$600,000</span>
              </div>
              <div className="module-card-body" style={{ padding: 0 }}>
                <table className="pl-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Long-term Debt</td>
                      <td className="num">$600,000</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ height: "1rem" }}></div>
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">
                  Shareholders&apos; Equity
                </div>
                <span className="badge badge-green">$1,744,840</span>
              </div>
              <div className="module-card-body" style={{ padding: 0 }}>
                <table className="pl-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Common Stock</td>
                      <td className="num">$500,000</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                    <tr>
                      <td>Retained Earnings</td>
                      <td className="num">$1,244,840</td>
                      <td>
                        <span className="badge badge-green">OK</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div className="module-card">
          <div className="module-card-header">
            <div className="module-card-title">⚠ Classification Warning</div>
          </div>
          <div className="module-card-body">
            <div className="finding-item warn">
              <div className="finding-dot warn"></div>
              <div>
                <div className="finding-text">
                  <strong>
                    Accounts Receivable $24,500 may be misclassified.
                  </strong>{" "}
                  Aging analysis indicates this invoice is 380 days outstanding.
                  Under GAAP, receivables beyond 12 months should be
                  reclassified to non-current assets. Current total overstated
                  by $24,500.
                </div>
                <div className="finding-meta">
                  CLASSIFICATION WARNING · GAAP ASC 310 · VERIFY WITH CONTROLLER
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
