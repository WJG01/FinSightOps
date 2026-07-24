# AuditAI

A Next.js (App Router) conversion of the AuditAI static HTML mockup.

## Structure

```
auditai-nextjs/
├── app/
│   ├── layout.js       # Root layout, loads global styles + metadata
│   ├── page.js         # Entry point, renders the client <App />
│   └── globals.css     # All styling from the original mockup
├── components/
│   ├── App.jsx          # Top-level state: which "page" is active
│   ├── Nav.jsx           # Fixed top navigation
│   ├── LandingPage.jsx
│   ├── DashboardPage.jsx
│   ├── PLPage.jsx        # Has its own tab state (Summary/Income/Margins/Flags)
│   ├── BalancePage.jsx
│   ├── ReceiptsPage.jsx
│   ├── ReconPage.jsx
│   └── SettingsPage.jsx  # Has its own toggle/input state
├── package.json
├── next.config.mjs
├── jsconfig.json
└── .gitignore
```

The original single HTML file used `showPage()` / `switchTab()` with vanilla
JS + CSS class toggling. That's been replaced with normal React state
(`useState`) in `App.jsx` (current page) and `PLPage.jsx` (current tab), and
per-toggle state in `SettingsPage.jsx`. All markup, classnames, and CSS were
carried over as-is so it looks identical to the mockup.

## Getting started

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Notes

- Built with Next.js 14 (App Router), plain JavaScript (no TypeScript).
- Fonts are pulled from Google Fonts via `@import` in `globals.css`, same as
  the original mockup.
- All data on the pages (KPIs, findings, receipts, etc.) is static/hardcoded,
  matching the original mockup — wire it up to real data sources as needed.
