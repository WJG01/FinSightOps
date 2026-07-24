"use client";

import { useState } from "react";

function Toggle({ defaultOn }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      type="button"
      className={`toggle ${on ? "on" : ""}`}
      onClick={() => setOn((v) => !v)}
      aria-pressed={on}
    ></button>
  );
}

function SettingInput({ defaultValue }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <input
      className="setting-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

export default function SettingsPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Settings</h2>
          <div className="sub">
            Configure audit thresholds, alerts, and integrations
          </div>
        </div>
      </div>
      <div className="settings-grid">
        <div className="settings-section">
          <div className="settings-section-header">
            P&amp;L Deviation Thresholds
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Deviation Alert (σ)</div>
              <div className="setting-desc">
                Flag items exceeding this many standard deviations
              </div>
            </div>
            <SettingInput defaultValue="2.0" />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">
                Historical Window (quarters)
              </div>
              <div className="setting-desc">
                Number of past quarters used for baseline
              </div>
            </div>
            <SettingInput defaultValue="8" />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Auto-flag on upload</div>
              <div className="setting-desc">
                Run P&amp;L analysis immediately on document upload
              </div>
            </div>
            <Toggle defaultOn={true} />
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">Receipt Authenticity</div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Metadata analysis</div>
              <div className="setting-desc">
                Check EXIF data and creation timestamps
              </div>
            </div>
            <Toggle defaultOn={true} />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Visual AI tampering detection</div>
              <div className="setting-desc">
                Use vision model to detect JPEG artifacts
              </div>
            </div>
            <Toggle defaultOn={true} />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Duplicate hash check</div>
              <div className="setting-desc">
                Compare file hashes across all submissions
              </div>
            </div>
            <Toggle defaultOn={true} />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Vendor database lookup</div>
              <div className="setting-desc">
                Cross-reference vendors against known registry
              </div>
            </div>
            <Toggle defaultOn={false} />
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">Balance Sheet Rules</div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Enforce accounting identity</div>
              <div className="setting-desc">
                Error if Assets ≠ Liabilities + Equity
              </div>
            </div>
            <Toggle defaultOn={true} />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">GAAP classification checks</div>
              <div className="setting-desc">
                Flag items that appear misclassified per GAAP
              </div>
            </div>
            <Toggle defaultOn={true} />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">A/R aging threshold (days)</div>
              <div className="setting-desc">
                Days before receivable flags as long-term
              </div>
            </div>
            <SettingInput defaultValue="365" />
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            Notifications &amp; Exports
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">
                Email alerts on critical findings
              </div>
              <div className="setting-desc">
                Send email when critical issues are detected
              </div>
            </div>
            <Toggle defaultOn={true} />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Auto-generate PDF report</div>
              <div className="setting-desc">
                Create report automatically after each audit run
              </div>
            </div>
            <Toggle defaultOn={false} />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-name">Audit log retention (days)</div>
              <div className="setting-desc">
                How long to keep historical audit records
              </div>
            </div>
            <SettingInput defaultValue="365" />
          </div>
        </div>
      </div>
    </div>
  );
}
