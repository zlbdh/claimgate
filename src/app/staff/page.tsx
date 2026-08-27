import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createAuditService } from "@/features/audit/audit-service";
import { readStaffPageSession } from "@/server/http/staff-page-session";
import { getHttpRuntime } from "@/server/http/runtime";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function StaffQueuePage() {
  await connection();
  const runtime = getHttpRuntime();
  const cookieStore = await cookies();
  const session = readStaffPageSession(cookieStore.get(DEMO_SESSION_COOKIE)?.value, runtime);
  if (!session) redirect("/");
  const queue = createAuditService(runtime).listStaffQueue({
    demoInstanceId: session.demoInstanceId,
    actorId: session.userId,
    sessionExpiresAt: session.expiresAt,
  });
  return (
    <main className="report-workspace staff-workspace">
      <Link className="workspace-back" href="/">← Return to ClaimGate desk</Link>
      <header className="workspace-header">
        <div>
          <p className="workspace-kicker">Staff desk · private queue</p>
          <h1>Claims waiting for review</h1>
          <p>Only aggregate eligibility and public item details are shown.</p>
        </div>
        <span className="workspace-ticket">Queue · {queue.length}/50</span>
      </header>
      <section className="workspace-panel" aria-labelledby="staff-queue-title">
        <h2 id="staff-queue-title">Review-qualified claims</h2>
        {queue.length === 0 ? <p className="workspace-state">No claims are waiting.</p> : (
          <ul className="report-list staff-queue">
            {queue.map((entry) => <li key={entry.claimId}>
              <Link href={`/staff/claims/${entry.claimId}`}>
                <span className="report-list-category">{entry.item.category}</span>
                <span>{entry.item.area} · {entry.item.color}</span>
                <span className="status-stamp status-under_review">UNDER REVIEW</span>
                <small>{entry.failedAttempts} failed · {entry.conflictCount} competing</small>
              </Link>
            </li>)}
          </ul>
        )}
      </section>
    </main>
  );
}
