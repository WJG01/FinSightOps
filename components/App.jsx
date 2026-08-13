"use client";

import { useState } from "react";
import Nav from "./Nav";
import LandingPage from "./LandingPage";
import DashboardPage from "./SummaryPage";
import DocUploadPage from "./DocUploadPage";
import PLPage from "./PLPage";
import BalancePage from "./BalancePage";
import ReceiptsPage from "./ReceiptsPage";
import ReconPage from "./ReconPage";
import RunProgressPage from "./RunProgressPage";
export default function App() {
  const [page, setPage] = useState("landing");

  const [pageParams, setPageParams] = useState({});

  const showPage = (name, params = {}) => {
    setPage(name);
    setPageParams(params);
    if (typeof window !== "undefined") {
      window.scrollTo(0, 0);
    }
  };
  return (
    <>
      <Nav page={page} showPage={showPage} />

      <div className="page">
        {page === "landing" && <LandingPage showPage={showPage} />}
        {page === "summary" && <DashboardPage showPage={showPage} />}
        {page === "upload" && <DocUploadPage showPage={showPage} />}
        {page === "pl" && <PLPage />}
        {page === "balance" && <BalancePage />}
        {page === "receipts" && <ReceiptsPage />}
        {page === "recon" && <ReconPage />}
        {page === "settings" && <SettingsPage />}
        {/* {page === "run" && <RunProgress showPage={showPage} />} */}
        {page === "run" && (
          <RunProgressPage
            showPage={showPage}
            quarterKeys={pageParams.quarterKeys || []}
          />
        )}
      </div>
    </>
  );
}
