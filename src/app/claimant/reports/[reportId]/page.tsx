import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { CandidateFinder } from "@/components/candidate-finder";
import { PrivacyBoundary } from "@/components/privacy-boundary";
import { ReportUpdateForm } from "@/components/report-update-form";
import { WebMcpPageScope } from "@/components/webmcp-provider";
import { DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createReportService } from "@/features/reports/report-service";
import { mintClaimStageCsrf, mintReportCsrf, readClaimantPageSession } from "@/server/http/claimant-page-session";
import { getHttpRuntime } from "@/server/http/runtime";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ReportDetailPage({ params }: { params: Promise<{ reportId: string }> }) {
  await connection();
  const runtime = getHttpRuntime();
  const cookieStore = await cookies();
  const session = readClaimantPageSession(cookieStore.get(DEMO_SESSION_COOKIE)?.value, runtime);
  if (!session) redirect("/");
  const { reportId } = await params;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reportId)) redirect("/claimant");
  const actor = {
    demoInstanceId: session.demoInstanceId,
    actorId: session.userId,
    sessionExpiresAt: session.expiresAt,
  };
  let report;
  try {
    report = createReportService(runtime).getOwned(actor, reportId);
  } catch {
    redirect("/claimant");
  }
  const archivePath = `/api/reports/${reportId}/archive`;
  const archiveCsrf = report.status === "DRAFT" || report.status === "PUBLISHED"
    ? mintReportCsrf({ runtime, session, routeKey: "api.reports.archive", path: archivePath, oneTime: true })
    : undefined;
  const updateCsrf = report.status === "DRAFT"
    ? mintReportCsrf({ runtime, session, routeKey: "api.reports.update", path: `/api/reports/${reportId}`, oneTime: false })
    : undefined;
  const publishCsrf = report.status === "DRAFT"
    ? mintReportCsrf({ runtime, session, routeKey: "api.reports.publish", path: `/api/reports/${reportId}/publish`, oneTime: true })
    : undefined;
  const stageCsrf = report.status === "PUBLISHED"
    ? mintClaimStageCsrf({ runtime, session, reportId })
    : undefined;

  return (
    <>
      <WebMcpPageScope
        scope={{
          role: "CLAIMANT",
          page: "REPORT",
          reportId,
          reportStatus: report.status,
          reportVersion: report.version,
        }}
        updateCsrfToken={updateCsrf}
        stageCsrfToken={stageCsrf}
      />
      <main className="report-workspace report-detail">
      <Link className="workspace-back" href="/claimant">← All reports</Link>
      <header className="workspace-header">
        <div>
          <p className="workspace-kicker">Claimant file · {report.status}</p>
          <h1>{report.category}</h1>
          <p>{report.area} · {report.color} · revision {report.version}</p>
        </div>
        <span className={`status-stamp status-${report.status.toLowerCase()}`}>{report.status}</span>
      </header>
      <nav className="claim-steps" aria-label="Claim progress">
        <strong>Report</strong><strong aria-current="step">Match</strong><span>Prove</span><span>Review</span><span>Pickup</span>
      </nav>
      <PrivacyBoundary />

      {report.status === "DRAFT" && updateCsrf && publishCsrf && archiveCsrf && (
        <section className="workspace-panel" aria-labelledby="edit-report-title">
          <p className="workspace-kicker">Private draft · revision {report.version}</p>
          <h2 id="edit-report-title">Review before publishing</h2>
          <ReportUpdateForm report={report} csrfToken={updateCsrf} />
          <div className="manual-actions" aria-label="Manual report actions">
            <form action={`/api/reports/${reportId}/publish`} method="post">
              <input type="hidden" name="csrfToken" value={publishCsrf} />
              <input type="hidden" name="expectedVersion" value={report.version} />
              <button type="submit">Publish report manually</button>
            </form>
            <form action={archivePath} method="post">
              <input type="hidden" name="csrfToken" value={archiveCsrf} />
              <input type="hidden" name="expectedVersion" value={report.version} />
              <button className="quiet-action" type="submit">Archive draft</button>
            </form>
          </div>
        </section>
      )}

      {report.status === "PUBLISHED" && archiveCsrf && (
        <>
          <CandidateFinder reportId={reportId} reportVersion={report.version} />
          <form className="archive-published" action={archivePath} method="post">
            <input type="hidden" name="csrfToken" value={archiveCsrf} />
            <input type="hidden" name="expectedVersion" value={report.version} />
            <button className="quiet-action" type="submit">Archive published report</button>
            <p>This is available only while no active claim depends on the report.</p>
          </form>
        </>
      )}

      {report.status !== "DRAFT" && report.status !== "PUBLISHED" && (
        <p className="workspace-state" role="status">This report is closed and remains available as a read-only record.</p>
      )}
      </main>
    </>
  );
}
