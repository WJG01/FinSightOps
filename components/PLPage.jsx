"use client";

import { useState } from "react";

const TABS = [
  { id: "summary", label: "Summary" },
  { id: "income", label: "Income Statement" },
  { id: "margins", label: "Margins & Trends" },
  { id: "flags", label: "Flagged Items" },
];

export default function PLPage() {
  const [tab, setTab] = useState("summary");

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>P&amp;L Analysis</h2>
          <div className="sub">Q3 2024 · Margins, trends &amp; deviation flags</div>
        </div>
        <div className="header-actions">
          <span className="badge badge-amber">1 Warning</span>
          <span className="badge badge-green">Score 72</span>
        </div>
      </div>

      <div className="tab-bar">
        {TABS.map((t) => (
          <div
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </div>
        ))}
      </div>

      <div
        style={{
          padding: "2rem",
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        {/* Summary tab */}
        {tab === "summary" && (
          <div>
            <div className="kpi-row" style={{ marginBottom: "1.5rem" }}>
              <div className="kpi-card">
                <div className="kpi-label">Total Revenue</div>
                <div className="kpi-value">$4.82M</div>
                <div className="kpi-sub up">↑ 12% YoY</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Gross Profit</div>
                <div className="kpi-value">$2.31M</div>
                <div className="kpi-sub">Margin: 47.9%</div>
              </div>
              <div className="kpi-card warn">
                <div className="kpi-label">Operating Expenses</div>
                <div className="kpi-value">$1.42M</div>
                <div className="kpi-sub down">↑ 22% vs prior (flagged)</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Net Income</div>
                <div className="kpi-value">$887K</div>
                <div className="kpi-sub up">Margin: 18.4%</div>
              </div>
            </div>
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">AI Observations</div>
              </div>
              <div className="module-card-body">
                <div className="finding-item warn">
                  <div className="finding-dot warn"></div>
                  <div>
                    <div className="finding-text">
                      <strong>
                        Marketing expense +38% above 8-quarter mean.
                      </strong>{" "}
                      This is a 2.1σ deviation. Similar spikes occurred in Q1
                      2022 and correlated with a new campaign launch — verify
                      if this applies.
                    </div>
                  </div>
                </div>
                <div className="finding-item ok">
                  <div className="finding-dot ok"></div>
                  <div>
                    <div className="finding-text">
                      <strong>Revenue growth of 12% is consistent</strong>{" "}
                      with trailing 4-quarter trend (avg 10.8%). No anomaly
                      detected.
                    </div>
                  </div>
                </div>
                <div className="finding-item ok">
                  <div className="finding-dot ok"></div>
                  <div>
                    <div className="finding-text">
                      <strong>COGS margin held steady at 52.1%</strong>,
                      within ±1.5% of historical norm. No cost-of-goods
                      anomaly.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Income Statement tab */}
        {tab === "income" && (
          <div className="module-card">
            <div className="module-card-header">
              <div className="module-card-title">
                Income Statement — Q3 2024
              </div>
            </div>
            <div className="module-card-body" style={{ padding: 0 }}>
              <table className="pl-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Line Item</th>
                    <th className="num">Q3 2024</th>
                    <th className="num">Q3 2023</th>
                    <th className="num">Deviation</th>
                    <th>Trend</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="head-row">
                    <td colSpan="6">REVENUE</td>
                  </tr>
                  <tr>
                    <td>Product Sales</td>
                    <td className="num">$3,940,000</td>
                    <td className="num">$3,520,000</td>
                    <td className="num deviation up">+11.9%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--green-500)", width: "75%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-green">OK</span>
                    </td>
                  </tr>
                  <tr>
                    <td>Service Revenue</td>
                    <td className="num">$880,000</td>
                    <td className="num">$790,000</td>
                    <td className="num deviation up">+11.4%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--green-500)", width: "65%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-green">OK</span>
                    </td>
                  </tr>
                  <tr className="head-row">
                    <td colSpan="6">COST OF GOODS SOLD</td>
                  </tr>
                  <tr>
                    <td>Direct Materials</td>
                    <td className="num">$1,680,000</td>
                    <td className="num">$1,510,000</td>
                    <td className="num">+11.3%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--amber-400)", width: "50%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-green">OK</span>
                    </td>
                  </tr>
                  <tr>
                    <td>Direct Labour</td>
                    <td className="num">$830,000</td>
                    <td className="num">$770,000</td>
                    <td className="num">+7.8%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--green-500)", width: "55%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-green">OK</span>
                    </td>
                  </tr>
                  <tr className="head-row">
                    <td colSpan="6">OPERATING EXPENSES</td>
                  </tr>
                  <tr className="flagged">
                    <td>Marketing &amp; Advertising</td>
                    <td className="num">$340,000</td>
                    <td className="num">$246,000</td>
                    <td className="num deviation up">+38.2%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--red-500)", width: "90%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-amber">⚠ Flag</span>
                    </td>
                  </tr>
                  <tr>
                    <td>General &amp; Admin</td>
                    <td className="num">$510,000</td>
                    <td className="num">$490,000</td>
                    <td className="num">+4.1%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--green-500)", width: "40%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-green">OK</span>
                    </td>
                  </tr>
                  <tr>
                    <td>Depreciation</td>
                    <td className="num">$120,000</td>
                    <td className="num">$118,000</td>
                    <td className="num">+1.7%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--green-500)", width: "30%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-green">OK</span>
                    </td>
                  </tr>
                  <tr>
                    <td>R&amp;D</td>
                    <td className="num">$445,000</td>
                    <td className="num">$420,000</td>
                    <td className="num">+6.0%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--green-500)", width: "45%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-green">OK</span>
                    </td>
                  </tr>
                  <tr className="head-row">
                    <td colSpan="6">NET INCOME</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>Net Profit</strong>
                    </td>
                    <td className="num">
                      <strong>$887,000</strong>
                    </td>
                    <td className="num">
                      <strong>$746,000</strong>
                    </td>
                    <td className="num deviation up">+18.9%</td>
                    <td>
                      <span className="trend-bar">
                        <span
                          className="trend-fill"
                          style={{ background: "var(--green-500)", width: "70%" }}
                        ></span>
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-green">OK</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Margins tab */}
        {tab === "margins" && (
          <div>
            <div className="kpi-row" style={{ marginBottom: "1.5rem" }}>
              <div className="kpi-card">
                <div className="kpi-label">Gross Margin</div>
                <div className="kpi-value">47.9%</div>
                <div className="kpi-sub">8Q avg: 46.2%</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Operating Margin</div>
                <div className="kpi-value">22.7%</div>
                <div className="kpi-sub">8Q avg: 24.1%</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Net Margin</div>
                <div className="kpi-value">18.4%</div>
                <div className="kpi-sub up">↑ 2.1% QoQ</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">EBITDA Margin</div>
                <div className="kpi-value">26.3%</div>
                <div className="kpi-sub">8Q avg: 25.8%</div>
              </div>
            </div>
            <div className="module-card">
              <div className="module-card-header">
                <div className="module-card-title">
                  8-Quarter Trend (Gross Margin %)
                </div>
              </div>
              <div className="module-card-body">
                <div className="bar-chart">
                  {[
                    ["Q4 2022", "88%", "44.1%"],
                    ["Q1 2023", "90%", "45.0%"],
                    ["Q2 2023", "91%", "45.5%"],
                    ["Q3 2023", "92%", "46.0%"],
                    ["Q4 2023", "93%", "46.5%"],
                    ["Q1 2024", "94%", "47.0%"],
                    ["Q2 2024", "95%", "47.5%"],
                    ["Q3 2024 ▶", "95.8%", "47.9%"],
                  ].map(([label, width, value], idx, arr) => (
                    <div className="bar-row" key={label}>
                      <div className="bar-label">{label}</div>
                      <div className="bar-track">
                        <div
                          className={`bar-fill ${
                            idx === arr.length - 1 ? "amber" : "green"
                          }`}
                          style={{ width }}
                        ></div>
                      </div>
                      <div className="bar-value">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Flags tab */}
        {tab === "flags" && (
          <div className="module-card">
            <div className="module-card-header">
              <div className="module-card-title">Flagged Line Items</div>
              <span className="badge badge-amber">1 item</span>
            </div>
            <div className="module-card-body">
              <div className="finding-item warn">
                <div className="finding-dot warn"></div>
                <div>
                  <div className="finding-text">
                    <strong>Marketing &amp; Advertising — $340,000</strong>
                    <br />
                    +38.2% above prior year. Exceeds 2σ threshold from
                    8-quarter rolling mean ($246K ± $28K). Review supporting
                    receipts and approval chain.
                  </div>
                  <div className="finding-meta">
                    DEVIATION 2.1σ · LINE 4.3 · REQUIRES REVIEW
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
