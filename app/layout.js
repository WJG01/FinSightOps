import "./globals.css";

export const metadata = {
  title: "AuditAI — Agentic Finance Auditing",
  description:
    "AuditAI runs end-to-end forensic analysis across your P&L statements, balance sheets, and receipts — then reconciles everything into a single unified finding.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
