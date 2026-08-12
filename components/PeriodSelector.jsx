"use client";

const currentYear = new Date().getFullYear();

export const FINANCIAL_YEARS = [];
for (let year = currentYear; year >= currentYear - 9; year--) {
  FINANCIAL_YEARS.push(year);
}

const QUARTERS = [
  { value: "all", label: "All" },
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
];

export default function PeriodSelector({
  financialYear,
  quarter,
  onFinancialYearChange,
  onQuarterChange,
  onRun,
}) {
  return (
    <div className="period-filter-bar">
      <div className="period-filter-fields">
        <div className="period-filter-group">
          <span className="period-filter-label">Financial Year</span>
          <select
            className="period-filter-select"
            value={financialYear}
            onChange={(e) => onFinancialYearChange(e.target.value)}
          >
            {FINANCIAL_YEARS.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>

        <div className="period-filter-group">
          <span className="period-filter-label">Quarter</span>
          <select
            className="period-filter-select"
            value={quarter}
            onChange={(e) => onQuarterChange(e.target.value)}
          >
            {QUARTERS.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button type="button" className="btn-primary period-filter-run" onClick={onRun}>
        Run
      </button>
    </div>
  );
}
