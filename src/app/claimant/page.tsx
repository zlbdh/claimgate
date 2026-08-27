import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ReportCreateForm } from "@/components/report-create-form";
import { ReportIndex } from "@/components/report-index";
import { PrivacyBoundary } from "@/components/privacy-boundary";
import { WebMcpPageScope } from "@/components/webmcp-provider";
import { DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createReportService } from "@/features/reports/report-service";
import { readClaimantPageSession, mintReportCsrf } from "@/server/http/claimant-page-session";
import { getHttpRuntime } from "@/server/http/runtime";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ClaimantWorkspacePage() {
  await connection();
  const runtime = getHttpRuntime();
  const cookieStore = await cookies();
  const session = readClaimantPageSession(cookieStore.get(DEMO_SESSION_COOKIE)?.value, runtime);
  if (!session) redirect("/");
  const actor = {
    demoInstanceId: session.demoInstanceId,
    actorId: session.userId,
    sessionExpiresAt: session.expiresAt,
  };
  let reports = [] as ReturnType<ReturnType<typeof createReportService>["listOwned"]>;
  let error: string | undefined;
  try {
    reports = createReportService(runtime).listOwned(actor);
  } catch {
    error = "Reports could not be loaded. Return to the desk and try again.";
  }
  const csrfToken = mintReportCsrf({
    runtime, session, routeKey: "api.reports.create", path: "/api/reports", oneTime: false,
  });

  return (
    <>
      <WebMcpPageScope
        scope={{ role: "CLAIMANT", page: "WORKSPACE" }}
        createCsrfToken={csrfToken}
      />
      <main className="report-workspace">
      <header className="workspace-header">
        <div>
          <p className="workspace-kicker">Claimant file · Northbridge</p>
          <h1>Lost report desk</h1>
          <p>Start privately, publish deliberately, then search only when you are ready.</p>
        </div>
        <span className="workspace-ticket">File CG–R</span>
      </header>
      <nav className="claim-steps" aria-label="Claim progress">
        <strong aria-current="step">Report</strong><span>Match</span><span>Prove</span><span>Review</span><span>Pickup</span>
      </nav>
      <div className="workspace-columns">
        <section className="workspace-panel" aria-labelledby="new-report-title">
          <p className="workspace-kicker">Step 01 · Report</p>
          <h2 id="new-report-title">Save a private draft</h2>
          <p className="panel-copy">Use broad, public descriptors only. You can revise the draft before publishing it.</p>
          <ReportCreateForm csrfToken={csrfToken} />
        </section>
        <aside className="workspace-rail">
          <PrivacyBoundary />
          <section aria-labelledby="your-reports-title">
            <h2 id="your-reports-title">Your reports</h2>
            <ReportIndex reports={reports} error={error} />
          </section>
        </aside>
      </div>
      </main>
    </>
  );
}
