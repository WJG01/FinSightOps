"use client";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "upload", label: "Upload Doc" },
  { id: "pl", label: "P&L Analysis" },
  { id: "balance", label: "Balance Sheet" },
  // { id: "receipts", label: "Receipts" },
  { id: "recon", label: "Reconciliation" },
  // { id: "settings", label: "Settings" },
];

export default function Nav({ page, showPage }) {
  return (
    <nav>
      <button className="nav-logo" onClick={() => showPage("landing")}>
        <span className="dot"></span> AuditAI
      </button>
      <ul className="nav-links">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <a
              onClick={() => showPage(item.id)}
              className={page === item.id ? "active" : ""}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
      <button className="nav-cta" onClick={() => showPage("dashboard")}>
        Open Audit
      </button>
    </nav>
  );
}
