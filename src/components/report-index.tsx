import Link from "next/link";
import type { PublicReportDto } from "@/features/reports/report-types";

export interface ReportIndexProps {
  reports: readonly PublicReportDto[];
  error?: string;
  className?: string;
}

export function ReportIndex({ reports, error, className = "" }: ReportIndexProps) {
  if (error) {
    return <p className={`workspace-state error-state ${className}`.trim()} role="alert">{error}</p>;
  }
  if (reports.length === 0) {
    return (
      <p className={`workspace-state empty-state ${className}`.trim()} role="status">
        No reports yet. Save a private draft to begin.
      </p>
    );
  }
  return (
    <ul className={`report-list ${className}`.trim()} aria-label="Your lost reports">
      {reports.map((report) => (
        <li key={report.reportId}>
          <Link href={`/claimant/reports/${report.reportId}`}>
            <span className="report-list-category">{report.category}</span>
            <span>{report.area} · {report.color}</span>
            <span className={`status-stamp status-${report.status.toLowerCase()}`}>{report.status}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
