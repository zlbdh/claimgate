import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { WebMcpPageScope } from "@/components/webmcp-provider";
import { DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createClaimService } from "@/features/claims/claim-service";
import { readClaimantPageSession } from "@/server/http/claimant-page-session";
import { getHttpRuntime } from "@/server/http/runtime";

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
  return (
    <>
      <WebMcpPageScope scope={{ role: "CLAIMANT", page: "CLAIM", claimStatus: "EVIDENCE_REQUIRED" }} />
      <main className="report-workspace claim-checkpoint">
        <Link className="workspace-back" href="/">← Return to ClaimGate desk</Link>
        <header className="workspace-header">
          <div>
            <p className="workspace-kicker">Step 03 · Prove</p>
            <h1>Evidence checkpoint</h1>
            <p>Your candidate is staged. The desk has not approved or released the item.</p>
          </div>
          <span className="status-stamp status-evidence-required">EVIDENCE REQUIRED</span>
        </header>
        <nav className="claim-steps" aria-label="Claim progress">
          <strong>Report</strong><strong>Match</strong><strong aria-current="step">Prove</strong><span>Review</span><span>Pickup</span>
        </nav>
        <section className="workspace-panel checkpoint-panel" aria-labelledby="checkpoint-title">
          <p className="workspace-kicker">Private human checkpoint</p>
          <h2 id="checkpoint-title">Prepare for a later manual evidence step</h2>
          <p>{claim.nextStep}</p>
          <dl className="checkpoint-ledger">
            <div><dt>Status</dt><dd>Evidence required</dd></div>
            <div><dt>Attempts used</dt><dd>{claim.attempts}</dd></div>
            <div><dt>Attempts remaining</dt><dd>{claim.remainingAttempts}</dd></div>
          </dl>
          <p className="workspace-state" role="status">
            No evidence form is available yet. A person will guide the private verification step later.
          </p>
        </section>
      </main>
    </>
  );
}
