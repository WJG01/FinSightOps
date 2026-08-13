// Plain singleton store — lives outside React, so it survives page navigation
// as long as the SPA itself isn't reloaded (client-side nav only).

let state = {
  isRunning: false,
  results: [],
  error: "",
  activeQuarterKeys: [],
};

const listeners = new Set();

function notify() {
  listeners.forEach((fn) => fn(state));
}

export function subscribeAudit(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAuditState() {
  return state;
}

function setState(patch) {
  state = { ...state, ...patch };
  notify();
}

// Same fields you had in your original file — copy AUDIT_TRIGGER_LAMBDA_URL /
// AUDIT_BUCKET / toDocTypeValue here, or import them if you extract them too.
const AUDIT_TRIGGER_LAMBDA_URL =
  "https://7tb7ncximsvqwoffyuym6v2yqu0slzsr.lambda-url.ap-southeast-1.on.aws/";
const AUDIT_BUCKET = "upload-bucket-raw";

export async function runAudit(quarterKeys, documentsByYear, toDocTypeValue) {
  if (quarterKeys.length === 0) return;

  setState({
    error: "",
    results: [],
    isRunning: true,
    activeQuarterKeys: quarterKeys,
  });

  try {
    for (const key of quarterKeys) {
      const [year, quarter] = key.split("-");
      const files = documentsByYear?.[year]?.[quarter] || [];
      if (files.length === 0) continue;

      const uploaded_item = files.map((file) => ({
        doc_type: toDocTypeValue(file.documentType),
        s3_key: `documents/${year}/${quarter}/${file.fileName}`,
      }));

      for (const item of uploaded_item) {
        const runPayload = {
          run_id: key,
          doc_type: item.doc_type,
          bucket: AUDIT_BUCKET,
          s3_key: item.s3_key,
        };

        try {
          const res = await fetch(AUDIT_TRIGGER_LAMBDA_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(runPayload),
          });
          const resultData = await res.json().catch(() => ({}));

          setState({
            results: [
              ...state.results,
              {
                fy_quarter: key,
                doc_type: item.doc_type,
                s3_key: item.s3_key,
                status: res.ok ? "success" : "failed",
                message: res.ok ? "Triggered" : resultData?.message || res.statusText,
              },
            ],
          });
        } catch (err) {
          setState({
            results: [
              ...state.results,
              {
                fy_quarter: key,
                doc_type: item.doc_type,
                s3_key: item.s3_key,
                status: "failed",
                message: err.message || "Network error",
              },
            ],
          });
        }
      }
    }
  } catch (err) {
    setState({ error: err.message || "Something went wrong while running the audit." });
  } finally {
    setState({ isRunning: false });
  }
}