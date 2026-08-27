import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ClaimStepper } from "@/components/claim-stepper";
import { StaffDecisionForm } from "@/components/staff-decision-form";
import { DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createAuditService } from "@/features/audit/audit-service";
import { getHttpRuntime } from "@/server/http/runtime";
import { mintClaimReviewCsrf, readStaffPageSession } from "@/server/http/staff-page-session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function StaffClaimReviewPage({ params }: { params: Promise<{ claimId: string }> }) {
  await connection();
  const runtime = getHttpRuntime();
  const cookieStore = await cookies();
  const session = readStaffPageSession(cookieStore.get(DEMO_SESSION_COOKIE)?.value, runtime);
  if (!session) redirect("/");
  const { claimId } = await params;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(claimId)) redirect("/staff");
  const actor = {
    demoInstanceId: session.demoInstanceId,
    actorId: session.userId,
    sessionExpiresAt: session.expiresAt,
  };
  let review;
  try { review = createAuditService(runtime).getStaffReview(actor, claimId); }
  catch { redirect("/staff"); }
  const token = (routeKey: "api.staff.claims.approve" | "api.staff.claims.reject" | "api.staff.claims.unlock", action: string) =>
    mintClaimReviewCsrf({ runtime, session, routeKey, path: `/api/staff/claims/${claimId}/${action}` });
  const approveToken = review.claim.status === "UNDER_REVIEW" ? token("api.staff.claims.approve", "approve") : undefined;
  const rejectToken = review.claim.status === "UNDER_REVIEW" ? token("api.staff.claims.reject", "reject") : undefined;
  const unlockToken = review.claim.status === "LOCKED" && review.claim.unlockCount === 0
    ? token("api.staff.claims.unlock", "unlock") : undefined;
  return (
    <main className="report-workspace staff-workspace">
      <Link className="workspace-back" href="/staff">← Staff review queue</Link>
      <header className="workspace-header">
        <div>
          <p className="workspace-kicker">Staff review · aggregate evidence only</p>
          <h1>{review.item.category}</h1>
          <p>{review.item.area} · {review.item.color} · claim revision {review.claim.version}</p>
        </div>
        <span className={`status-stamp status-${review.claim.status.toLowerCase()}`}>{review.claim.status}</span>
      </header>
      <ClaimStepper status={review.claim.status} />
      <div className="workspace-columns">
        <section className="workspace-panel">
          <h2>Public comparison</h2>
          <p>{review.item.publicDescription}</p>
          <dl className="checkpoint-ledger">
            <div><dt>Failed attempts</dt><dd>{review.claim.failedAttempts}</dd></div>
            <div><dt>Competing claims</dt><dd>{review.conflict.conflictCount}</dd></div>
            <div><dt>Unlock used</dt><dd>{review.claim.unlockCount}/1</dd></div>
          </dl>
          <StaffDecisionForm
            claimId={claimId}
            status={review.claim.status}
            claimVersion={review.claim.version}
            itemVersion={review.item.itemVersion}
            unlockCount={review.claim.unlockCount}
            approveCsrfToken={approveToken}
            rejectCsrfToken={rejectToken}
            unlockCsrfToken={unlockToken}
          />
        </section>
        <aside className="workspace-rail">
          <section><h2>Lost report</h2><p>{review.report.publicDescription}</p></section>
          <section><h2>Redacted timeline</h2><ol className="timeline-list">
            {review.timeline.map((entry, index) => <li key={`${entry.occurredAtMs}-${index}`}>
              <strong>{entry.action}</strong><span>{entry.actor} · {entry.result}</span>
            </li>)}
          </ol></section>
        </aside>
      </div>
    </main>
  );
}
