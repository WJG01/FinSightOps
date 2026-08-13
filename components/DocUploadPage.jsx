"use client";

import { useState, useEffect, useCallback } from "react";
import { runAudit } from "@/lib/auditStore";


const DOCUMENT_TYPES = [
  { value: "invoice", label: "Invoice" },
  { value: "balance_sheet", label: "Balance Sheet" },
  { value: "bank_statement", label: "Bank Statement" },
  { value: "receipt", label: "Receipt" },
];

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

// Your upload Lambda (multipart/form-data POST)
const UPLOAD_LAMBDA_URL =
  "https://k74xcs6jalipde6byvaumfelba0zzgxd.lambda-url.ap-southeast-1.on.aws/";

// Your new list/download Lambda (GET, ?action=list | ?action=download&fileId=...)
// Replace with the Function URL you get after deploying list_and_download_documents_lambda.py
const DOCS_LAMBDA_URL =
  "https://5f5nhc7vor7cazrn5c5eef24gq0aopjr.lambda-url.ap-southeast-1.on.aws/";

// Endpoint that triggers a single-document audit run
const AUDIT_TRIGGER_LAMBDA_URL =
  "https://7tb7ncximsvqwoffyuym6v2yqu0slzsr.lambda-url.ap-southeast-1.on.aws/";

// Bucket where raw uploads live
const AUDIT_BUCKET = "upload-bucket-raw";

// Maps a stored documentType (label or value) back to the lambda's expected doc_type value
function toDocTypeValue(rawType) {
  const match = DOCUMENT_TYPES.find(
    (d) => d.value === rawType || d.label === rawType,
  );
  return match
    ? match.value
    : String(rawType || "")
        .toLowerCase()
        .replace(/\s+/g, "_");
}

function totalForYear(yearData) {
  return QUARTERS.reduce((sum, q) => sum + (yearData?.[q]?.length || 0), 0);
}

export default function DocUploadPage({ showPage }) {
  // --- Upload form state ---
  const [documentDate, setDocumentDate] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  // --- Uploaded documents list state ---
  const [documentsByYear, setDocumentsByYear] = useState({});
  const [isLoadingDocs, setIsLoadingDocs] = useState(true);
  const [docsError, setDocsError] = useState("");
  const [downloadingFileId, setDownloadingFileId] = useState(null);

  const years = Object.keys(documentsByYear).sort((a, b) => b - a);
  const [openYear, setOpenYear] = useState(null);
  const [openQuarter, setOpenQuarter] = useState(null);

  const totalDocs = years.reduce(
    (sum, y) => sum + totalForYear(documentsByYear[y]),
    0,
  );

  // Fetch the document list from the new Lambda
  const fetchDocuments = useCallback(async () => {
    setIsLoadingDocs(true);
    setDocsError("");
    try {
      const res = await fetch(`${DOCS_LAMBDA_URL}?action=list`);
      if (!res.ok) {
        throw new Error(`Failed to load documents (${res.status})`);
      }
      const data = await res.json();
      const yearsData = data.years || {};
      setDocumentsByYear(yearsData);

      const sortedYears = Object.keys(yearsData).sort((a, b) => b - a);
      if (sortedYears.length > 0) {
        setOpenYear((prev) => prev ?? sortedYears[0]);
        setOpenQuarter((prev) => prev ?? `${sortedYears[0]}-Q1`);
      }
    } catch (err) {
      console.error("Failed to fetch documents", err);
      setDocsError(err.message || "Could not load uploaded documents.");
    } finally {
      setIsLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const toggleYear = (year) => {
    setOpenYear((prev) => (prev === year ? null : year));
  };

  const toggleQuarter = (key) => {
    setOpenQuarter((prev) => (prev === key ? null : key));
  };

  const handleFileChange = (e) => {
    setSelectedFile(e.target.files?.[0] || null);
    setUploadError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!selectedFile) {
      setUploadError("Please select a file to upload.");
      return;
    }

    setIsUploading(true);
    setUploadError("");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("fileName", selectedFile.name);
      formData.append(
        "contentType",
        selectedFile.type || "application/octet-stream",
      );
      formData.append("documentType", documentType);
      formData.append("documentDate", documentDate);

      const res = await fetch(UPLOAD_LAMBDA_URL, {
        method: "POST",
        body: formData,
        // Don't set Content-Type manually — the browser sets the multipart
        // boundary automatically when body is a FormData instance.
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Upload failed (${res.status}): ${text || res.statusText}`,
        );
      }

      setSelectedFile(null);
      setDocumentDate("");
      setDocumentType("");

      // Refresh the list so the newly uploaded file shows up immediately
      await fetchDocuments();
    } catch (err) {
      console.error("Upload error", err);
      setUploadError(err.message || "Something went wrong during upload.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleDownload = async (fileId) => {
    setDownloadingFileId(fileId);
    try {
      const res = await fetch(
        `${DOCS_LAMBDA_URL}?action=download&fileId=${encodeURIComponent(fileId)}`,
      );
      if (!res.ok) {
        throw new Error(`Could not get download link (${res.status})`);
      }
      const data = await res.json();
      // Open the presigned S3 URL directly — the browser handles the download.
      window.open(data.downloadUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("Download error", err);
      alert(err.message || "Could not download this file.");
    } finally {
      setDownloadingFileId(null);
    }
  };

  // --- Selection state for running audit ---
  const [selectedQuarters, setSelectedQuarters] = useState(new Set());

  const [isRunningAudit, setIsRunningAudit] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [auditResults, setAuditResults] = useState([]); // per-document result log

  const toggleQuarterSelection = (key) => {
    setSelectedQuarters((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleRunAudit = async () => {
    const quarterKeys = Array.from(selectedQuarters);
    if (quarterKeys.length === 0) return;

    // Fire-and-forget — audit keeps running in the module-level store
    // regardless of which page component is currently mounted.
    runAudit(quarterKeys, documentsByYear, toDocTypeValue);

    setIsRunningAudit(false);
    showPage("run", { quarterKeys });
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Upload Document</h2>
          <div className="sub">
            Upload financial documents to start Audit Run and Financial Analysis
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
        {/* --- Upload form --- */}
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

            {uploadError && (
              <p style={{ color: "red", marginTop: "0.75rem" }}>
                {uploadError}
              </p>
            )}

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
                disabled={isUploading}
              >
                {isUploading ? "Uploading…" : "Upload Document"}
              </button>
            </div>
          </div>
        </form>

        {/* --- Uploaded documents list --- */}
        <div className="module-card">
          <div className="module-card-header">
            <div className="module-card-title">Uploaded Documents</div>
            <button
              type="button"
              className="btn-primary"
              onClick={handleRunAudit}
              disabled={selectedQuarters.size === 0 || isRunningAudit}
              style={{ padding: "0.4rem 1.2rem", fontSize: "0.78rem" }}
            >
              {isRunningAudit ? "Running audit…" : "Run Audit"}
            </button>
          </div>
          <div className="module-card-body">
            {isLoadingDocs && <p>Loading documents…</p>}
            {docsError && <p style={{ color: "red" }}>{docsError}</p>}

            {!isLoadingDocs && !docsError && years.length === 0 && (
              <p className="finding-meta">No documents uploaded yet.</p>
            )}

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {years.map((year) => {
                const yearData = documentsByYear[year];
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

                                <span
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.6rem",
                                  }}
                                >
                                  <span className="finding-meta">
                                    {files.length === 0
                                      ? "No documents"
                                      : `${files.length} file${files.length === 1 ? "" : "s"}`}
                                  </span>
                                  <input
                                    type="checkbox"
                                    checked={selectedQuarters.has(key)}
                                    disabled={files.length === 0}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={() => toggleQuarterSelection(key)}
                                    style={{
                                      accentColor: "var(--amber-400)",
                                      cursor: files.length
                                        ? "pointer"
                                        : "not-allowed",
                                    }}
                                  />
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
                                      key={file.fileId}
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
                                            {file.fileName}
                                          </div>
                                          <div className="finding-meta">
                                            {file.documentType} ·{" "}
                                            {file.documentDate}
                                          </div>
                                        </div>
                                      </div>

                                      {/* Download button */}
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleDownload(file.fileId)
                                        }
                                        disabled={
                                          downloadingFileId === file.fileId
                                        }
                                        className="mono"
                                        style={{
                                          fontSize: "0.7rem",
                                          color: "var(--slate-300)",
                                          background: "transparent",
                                          border: "1px solid var(--slate-700)",
                                          borderRadius: "4px",
                                          padding: "0.25rem 0.6rem",
                                          cursor: "pointer",
                                        }}
                                      >
                                        {downloadingFileId === file.fileId
                                          ? "Preparing…"
                                          : "⬇ Download"}
                                      </button>
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
