import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { WebMcpPageScope } from "@/components/webmcp-provider";
import { ClaimStepper } from "@/components/claim-stepper";
import { EvidenceForm } from "@/components/evidence-form";
import { PickupPassPanel } from "@/components/pickup-pass-panel";
import { DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createClaimService } from "@/features/claims/claim-service";
import { createPickupPassService } from "@/features/claims/pickup-pass-service";
import { mintReportCsrf, readClaimantPageSession } from "@/server/http/claimant-page-session";
import { getHttpRuntime } from "@/server/http/runtime";
import { mintClaimReviewCsrf } from "@/server/http/staff-page-session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ClaimCheckpointPage({ params }: { params: Promise<{ claimId: string }> }) {
  await connection();
  const runtime = getHttpRuntime();
  const cookieStore = await cookies();
  const session = readClaimantPageSession(cookieStore.get(DEMO_SESSION_COOKIE)?.value, runtime);
  if (!session) redirect("/");
  const { claimId } = await params;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(claimId)) redirect("/claimant");
  let claim;
  try {
    claim = createClaimService(runtime).getOwned({
      demoInstanceId: session.demoInstanceId,
      actorId: session.userId,
      sessionExpiresAt: session.expiresAt,
    }, claimId);
  } catch {
    redirect("/claimant");
  }
  const evidenceCsrf = claim.status === "EVIDENCE_REQUIRED"
    ? mintClaimReviewCsrf({
        runtime,
        session,
        routeKey: "api.claims.evidence",
        path: `/api/claims/${claimId}/evidence`,
      })
    : undefined;
  const pickup = ["APPROVED", "PICKUP_READY", "COLLECTED"].includes(claim.status)
    ? createPickupPassService(runtime).getInstructions({
        demoInstanceId: session.demoInstanceId,
        actorId: session.userId,
        sessionExpiresAt: session.expiresAt,
      }, claimId)
    : undefined;
  const issueCsrf = claim.status === "APPROVED"
    ? mintReportCsrf({
        runtime, session, routeKey: "api.claims.pickup.issue",
        path: `/api/claims/${claimId}/pickup-pass/issue`, oneTime: true,
      })
    : undefined;
  const reissueCsrf = claim.status === "PICKUP_READY"
    ? mintReportCsrf({
        runtime, session, routeKey: "api.claims.pickup.reissue",
        path: `/api/claims/${claimId}/pickup-pass/reissue`, oneTime: true,
      })
    : undefined;
  const heading = claim.status === "EVIDENCE_REQUIRED" ? "Evidence checkpoint"
    : claim.status === "UNDER_REVIEW" ? "Waiting for Staff review"
      : claim.status === "LOCKED" ? "Evidence attempts locked"
        : "Claim status";
  return (
    <>
      <WebMcpPageScope scope={{
        role: "CLAIMANT", page: "CLAIM", claimId,
        claimStatus: claim.status, claimVersion: claim.version,
      }} />
      <main className="report-workspace claim-checkpoint">
        <Link className="workspace-back" href="/">← Return to ClaimGate desk</Link>
        <header className="workspace-header">
          <div>
            <p className="workspace-kicker">Step 03 · Prove</p>
            <h1>{heading}</h1>
            <p>The desk reveals only aggregate claim state; private evidence is never shown here.</p>
          </div>
          <span className={`status-stamp status-${claim.status.toLowerCase()}`}>{claim.status}</span>
        </header>
        <ClaimStepper status={claim.status} />
        <section className="workspace-panel checkpoint-panel" aria-labelledby="checkpoint-title">
          <p className="workspace-kicker">Private human checkpoint</p>
          <h2 id="checkpoint-title">Claim review state</h2>
          <p>{claim.nextStep}</p>
          <dl className="checkpoint-ledger">
            <div><dt>Status</dt><dd>{claim.status}</dd></div>
            <div><dt>Failed attempts</dt><dd>{claim.failedAttempts}</dd></div>
            <div><dt>Attempts remaining</dt><dd>{claim.remainingAttempts}</dd></div>
          </dl>
          {claim.status === "EVIDENCE_REQUIRED" && evidenceCsrf && (
            <EvidenceForm
              key={`${claimId}:${claim.version}`}
              claimId={claimId}
              expectedVersion={claim.version}
              csrfToken={evidenceCsrf}
            />
          )}
          {claim.status === "LOCKED" && (
            <p className="workspace-state" role="status">
              {claim.unlockCount === 0
                ? "A Staff reviewer may unlock this claim once."
                : "The one Staff unlock has already been used; this lock is final."}
            </p>
          )}
          {claim.status === "UNDER_REVIEW" && (
            <p className="workspace-state" role="status">Evidence is eligible and waiting for Staff review.</p>
          )}
          {pickup && <>
            <p className="workspace-state">{pickup.deskName} · {pickup.hours}</p>
            <PickupPassPanel
              claimId={claimId}
              status={claim.status}
              claimVersion={pickup.claimVersion}
              generation={pickup.generation}
              expiresAtMs={pickup.expiresAtMs}
              issueCsrfToken={issueCsrf}
              reissueCsrfToken={reissueCsrf}
            />
          </>}
          {claim.status === "COLLECTED" && (
            <p className="workspace-state" role="status">Pickup is complete and the credential is consumed.</p>
          )}
          {claim.status === "REJECTED" && (
            <p className="workspace-state" role="status">This claim is read-only at its current stage.</p>
          )}
        </section>
      </main>
    </>
  );
}
