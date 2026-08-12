"use client";

import { useState } from "react";
import PeriodSelector, { FINANCIAL_YEARS } from "./PeriodSelector";

export default function SummaryPage({ showPage }) {
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
          <h2>Summary Dashboard</h2>
          <div className="sub">Q3 2024 · FY Review · Last run 14 min ago</div>
        </div>
        <div className="header-actions">
          <span className="badge badge-amber">3 Warnings</span>
          <span className="badge badge-red">1 Critical</span>
          <button className="btn-primary" onClick={() => showPage("recon")}>
            Generate Summary Report
          </button>
        </div>
      </div>

      <div className="dashboard-body">
        {/* KPI Row */}
        <div className="kpi-row">
          <div className="kpi-card">
            <div className="kpi-label">Audit Score</div>
            <div className="kpi-value">
              76
              <span style={{ fontSize: "1rem", color: "var(--slate-400)" }}>
                /100
              </span>
            </div>
            <div className="kpi-sub down">↓ 4 pts from last period</div>
          </div>
          <div className="kpi-card warn">
            <div className="kpi-label">Flagged Items</div>
            <div className="kpi-value">4</div>
            <div className="kpi-sub">3 warnings · 1 critical</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Net Margin</div>
            <div className="kpi-value">
              18.4
              <span style={{ fontSize: "1rem", color: "var(--slate-400)" }}>
                %
              </span>
            </div>
            <div className="kpi-sub up">↑ 2.1% vs prior quarter</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Balance Check</div>
            <div
              className="kpi-value"
              style={{ color: "var(--green-400)", fontSize: "1.6rem" }}
            >
              ✓ Balanced
            </div>
            <div className="kpi-sub">Assets = Liab + Equity</div>
          </div>
          <div className="kpi-card alert">
            <div className="kpi-label">Suspicious Receipts</div>
            <div className="kpi-value">1</div>
            <div className="kpi-sub down">Potential forgery detected</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Reconciled</div>
            <div className="kpi-value">
              94
              <span style={{ fontSize: "1rem", color: "var(--slate-400)" }}>
                %
              </span>
            </div>
            <div className="kpi-sub">47 of 50 entries matched</div>
          </div>
        </div>

        {/* Main content area */}
        <div className="two-col">
          {/* Recent Findings */}
          <div className="module-card">
            <div className="module-card-header">
              <div className="module-card-title">🔍 Recent Audit Findings</div>
              <span className="badge badge-amber">Live</span>
            </div>
            <div className="module-card-body">
              <div className="finding-item alert">
                <div className="finding-dot alert"></div>
                <div>
                  <div className="finding-text">
                    <strong>Receipt #R-0047 — Possible Forgery</strong>
                    <br />
                    Metadata timestamp mismatch and JPEG compression artifacts
                    suggest post-processing.
                  </div>
                  <div className="finding-meta">
                    RECEIPTS · Critical · 14 min ago
                  </div>
                </div>
              </div>
              <div className="finding-item warn">
                <div className="finding-dot warn"></div>
                <div>
                  <div className="finding-text">
                    <strong>Marketing Expense deviation +38%</strong>
                    <br />
                    Line item exceeds 2σ from 8-quarter historical mean.
                    Requires review.
                  </div>
                  <div className="finding-meta">
                    P&amp;L ANALYSIS · Warning · 14 min ago
                  </div>
                </div>
              </div>
              <div className="finding-item warn">
                <div className="finding-dot warn"></div>
                <div>
                  <div className="finding-text">
                    <strong>Accounts Receivable classification</strong>
                    <br />
                    $24,500 entry may be misclassified under current vs
                    non-current assets.
                  </div>
                  <div className="finding-meta">
                    BALANCE SHEET · Warning · 14 min ago
                  </div>
                </div>
              </div>
              <div className="finding-item warn">
                <div className="finding-dot warn"></div>
                <div>
                  <div className="finding-text">
                    <strong>3 receipts not tied to P&amp;L entries</strong>
                    <br />
                    Total unreconciled amount: $8,230. No matching expense line
                    found.
                  </div>
                  <div className="finding-meta">
                    RECONCILIATION · Warning · 14 min ago
                  </div>
                </div>
              </div>
              <div className="finding-item ok">
                <div className="finding-dot ok"></div>
                <div>
                  <div className="finding-text">
                    <strong>Balance sheet identity verified</strong>
                    <br />
                    Assets $2,847,320 = Liabilities $1,102,480 + Equity
                    $1,744,840
                  </div>
                  <div className="finding-meta">
                    BALANCE SHEET · Passed · 14 min ago
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right panel */}
          <div
            style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
          >
            {/* Audit Score */}
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">Overall Score</div>
              </div>
              <div className="score-ring-wrap">
                <div className="score-ring">
                  <div className="score-inner">
                    <span className="score-num">76</span>
                    <span className="score-label">/ 100</span>
                  </div>
                </div>
                <div style={{ marginTop: "1rem", width: "100%" }}>
                  <div className="bar-chart">
                    <div className="bar-row">
                      <div className="bar-label">P&amp;L</div>
                      <div className="bar-track">
                        <div
                          className="bar-fill amber"
                          style={{ width: "72%" }}
                        ></div>
                      </div>
                      <div className="bar-value">72</div>
                    </div>
                    <div className="bar-row">
                      <div className="bar-label">Balance</div>
                      <div className="bar-track">
                        <div
                          className="bar-fill green"
                          style={{ width: "96%" }}
                        ></div>
                      </div>
                      <div className="bar-value">96</div>
                    </div>
                    <div className="bar-row">
                      <div className="bar-label">Receipts</div>
                      <div className="bar-track">
                        <div
                          className="bar-fill red"
                          style={{ width: "58%" }}
                        ></div>
                      </div>
                      <div className="bar-value">58</div>
                    </div>
                    <div className="bar-row">
                      <div className="bar-label">Recon</div>
                      <div className="bar-track">
                        <div
                          className="bar-fill amber"
                          style={{ width: "80%" }}
                        ></div>
                      </div>
                      <div className="bar-value">80</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Module Status */}
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">Module Status</div>
              </div>
              <div className="module-card-body">
                <div className="module-status-grid">
                  <div className="status-tile" onClick={() => showPage("pl")}>
                    <div className="status-tile-name">P&amp;L Analysis</div>
                    <div className="status-tile-status text-amber">
                      1 Warning
                    </div>
                  </div>
                  <div
                    className="status-tile"
                    onClick={() => showPage("balance")}
                  >
                    <div className="status-tile-name">Balance Sheet</div>
                    <div className="status-tile-status text-green">Passed</div>
                  </div>
                  <div
                    className="status-tile alert"
                    onClick={() => showPage("receipts")}
                  >
                    <div className="status-tile-name">Receipts</div>
                    <div className="status-tile-status text-red">
                      1 Critical
                    </div>
                  </div>
                  <div
                    className="status-tile warn"
                    onClick={() => showPage("recon")}
                  >
                    <div className="status-tile-name">Reconciliation</div>
                    <div className="status-tile-status text-amber">2 Gaps</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
