"use client";

import { useState } from "react";

const DOCUMENT_TYPES = [
  { value: "invoice", label: "Invoice" },
  { value: "balance_sheet", label: "Balance Sheet" },
  { value: "bank_statement", label: "Bank Statement" },
  { value: "receipt", label: "Receipt" },
];

// Mock data — grouped Financial Year -> Quarter -> files.
// Swap this for a real fetch when wiring up the backend.
const MOCK_FILES = {
  2026: {
    Q1: [
      {
        name: "invoice_techsupplies_0047.pdf",
        type: "Invoice",
        date: "2026-01-14",
      },
      {
        name: "receipt_aws_cloud_0041.pdf",
        type: "Receipt",
        date: "2026-02-02",
      },
      {
        name: "bank_statement_jan2026.pdf",
        type: "Bank Statement",
        date: "2026-02-05",
      },
    ],
    Q2: [
      {
        name: "balance_sheet_q2_2026.pdf",
        type: "Balance Sheet",
        date: "2026-04-18",
      },
      {
        name: "invoice_office_depot_0031.pdf",
        type: "Invoice",
        date: "2026-05-09",
      },
    ],
    Q3: [],
    Q4: [],
  },
  2025: {
    Q1: [],
    Q2: [],
    Q3: [],
    Q4: [
      {
        name: "receipt_delta_airlines_0044.pdf",
        type: "Receipt",
        date: "2025-11-22",
      },
      {
        name: "bank_statement_dec2025.pdf",
        type: "Bank Statement",
        date: "2025-12-30",
      },
    ],
  },
};

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

function totalForYear(yearData) {
  return QUARTERS.reduce((sum, q) => sum + (yearData[q]?.length || 0), 0);
}

export default function DocUploadPage() {
  const [documentDate, setDocumentDate] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);

  const years = Object.keys(MOCK_FILES).sort((a, b) => b - a);
  const [openYear, setOpenYear] = useState(years[0]);
  const [openQuarter, setOpenQuarter] = useState(`${years[0]}-Q1`);

  const totalDocs = years.reduce(
    (sum, y) => sum + totalForYear(MOCK_FILES[y]),
    0,
  );

  const toggleYear = (year) => {
    setOpenYear((prev) => (prev === year ? null : year));
  };

  const toggleQuarter = (key) => {
    setOpenQuarter((prev) => (prev === key ? null : key));
  };

  const handleFileChange = (e) => {
    setSelectedFile(e.target.files?.[0] || null);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    console.log("Upload document", {
      documentDate,
      documentType,
      selectedFile,
    });
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Upload Document</h2>
          <div className="sub">
            Submit a financial document for verification and audit
            reconciliation
          </div>
        </div>
        <div className="header-actions">
          <span className="badge badge-blue">
            {totalDocs} Documents on File
          </span>
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
        <form onSubmit={handleSubmit} className="module-card">
          <div className="module-card-header">
            <div className="module-card-title">Document Details</div>
          </div>
          <div className="module-card-body">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "1.25rem",
                marginBottom: "1.5rem",
              }}
            >
              <div>
                <label className="kpi-label" style={{ display: "block" }}>
                  Document Date
                </label>
                <input
                  type="date"
                  value={documentDate}
                  onChange={(e) => setDocumentDate(e.target.value)}
                  required
                  className="setting-input"
                  style={{ width: "100%", textAlign: "left" }}
                />
              </div>
              <div>
                <label className="kpi-label" style={{ display: "block" }}>
                  Document Type
                </label>
                <select
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  required
                  className="setting-input"
                  style={{ width: "100%", textAlign: "left" }}
                >
                  <option value="" disabled>
                    Select type…
                  </option>
                  {DOCUMENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="kpi-label" style={{ display: "block" }}>
              File
            </label>
            <label
              htmlFor="documentFile"
              className="upload-zone"
              style={{ display: "block" }}
            >
              <div className="upload-icon">📎</div>
              <p>
                {selectedFile
                  ? selectedFile.name
                  : "Drop a document here or click to upload — PDF, JPG, PNG accepted"}
              </p>
            </label>
            <input
              id="documentFile"
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFileChange}
              required
              style={{ display: "none" }}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: "1.5rem",
              }}
            >
              <button
                type="submit"
                className="btn-primary"
                style={{ border: "none", cursor: "pointer" }}
              >
                Upload Document
              </button>
            </div>
          </div>
        </form>

        <div className="module-card">
          <div className="module-card-header">
            <div className="module-card-title">Uploaded Documents</div>
          </div>
          <div className="module-card-body">
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {years.map((year) => {
                const yearData = MOCK_FILES[year];
                const yearOpen = openYear === year;
                const yearCount = totalForYear(yearData);

                return (
                  <div key={year}>
                    <div
                      className="status-tile"
                      onClick={() => toggleYear(year)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        borderLeft: "3px solid var(--slate-700)",
                      }}
                    >
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.6rem",
                        }}
                      >
                        <span
                          className="mono text-amber"
                          style={{
                            display: "inline-block",
                            transform: yearOpen ? "rotate(90deg)" : "none",
                            transition: "transform 0.15s",
                          }}
                        >
                          ▸
                        </span>
                        <span className="status-tile-status">
                          Financial Year {year}
                        </span>
                      </span>
                      <span className="badge badge-blue">
                        {yearCount} document{yearCount === 1 ? "" : "s"}
                      </span>
                    </div>

                    {yearOpen && (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.6rem",
                          marginTop: "0.6rem",
                          marginLeft: "1.5rem",
                        }}
                      >
                        {QUARTERS.map((quarter) => {
                          const key = `${year}-${quarter}`;
                          const files = yearData[quarter] || [];
                          const quarterOpen = openQuarter === key;

                          return (
                            <div key={key}>
                              <div
                                className="status-tile"
                                onClick={() =>
                                  files.length && toggleQuarter(key)
                                }
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  borderLeft: "3px solid var(--slate-700)",
                                  padding: "0.6rem 0.9rem",
                                  cursor: files.length ? "pointer" : "default",
                                  opacity: files.length ? 1 : 0.5,
                                }}
                              >
                                <span
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.5rem",
                                  }}
                                >
                                  <span
                                    className="mono"
                                    style={{
                                      display: "inline-block",
                                      color: "var(--slate-500)",
                                      fontSize: "0.75rem",
                                      transform: quarterOpen
                                        ? "rotate(90deg)"
                                        : "none",
                                      transition: "transform 0.15s",
                                    }}
                                  >
                                    ▸
                                  </span>
                                  <span className="status-tile-name">
                                    {quarter}
                                  </span>
                                </span>
                                <span className="finding-meta">
                                  {files.length === 0
                                    ? "No documents"
                                    : `${files.length} file${files.length === 1 ? "" : "s"}`}
                                </span>
                              </div>

                              {quarterOpen && files.length > 0 && (
                                <div
                                  style={{
                                    marginTop: "0.4rem",
                                    marginLeft: "1.25rem",
                                    borderLeft: "1px solid var(--slate-800)",
                                    paddingLeft: "1rem",
                                  }}
                                >
                                  {files.map((file) => (
                                    <div
                                      key={file.name}
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: "0.75rem",
                                        padding: "0.6rem 0",
                                        borderBottom:
                                          "1px solid var(--slate-800)",
                                      }}
                                    >
                                      {/* File info */}
                                      <div
                                        style={{
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "0.6rem",
                                        }}
                                      >
                                        <span>🧾</span>
                                        <div>
                                          <div
                                            style={{
                                              fontSize: "0.82rem",
                                              color: "var(--slate-200)",
                                            }}
                                          >
                                            {file.name}
                                          </div>
                                          <div className="finding-meta">
                                            {file.type} · {file.date}
                                          </div>
                                        </div>
                                      </div>

                                      {/* Download button */}
                                      <a
                                        href="#"
                                        download={file.name}
                                        className="mono"
                                        style={{
                                          fontSize: "0.7rem",
                                          color: "var(--slate-300)",
                                          border: "1px solid var(--slate-700)",
                                          borderRadius: "4px",
                                          padding: "0.25rem 0.6rem",
                                          textDecoration: "none",
                                        }}
                                      >
                                        ⬇ Download
                                      </a>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
