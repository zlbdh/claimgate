import type { DemoRole } from "@/shared/demo-identity";

export function DemoRoleBar({
  role,
  expiresAt,
  csrfToken,
}: {
  role: DemoRole;
  expiresAt: number;
  csrfToken: string;
}) {
  const targetRole: DemoRole = role === "CLAIMANT" ? "STAFF" : "CLAIMANT";
  const roleLabel = role === "CLAIMANT" ? "Claimant" : "Staff";
  const targetLabel = targetRole === "CLAIMANT" ? "Claimant" : "Staff";
  return (
    <aside className="demo-role-bar" aria-label="Public demo session">
      <div className="demo-role-status" role="status">
        <strong>Current role: {roleLabel}</strong>
        <span>Expires: {new Date(expiresAt).toISOString()}</span>
        <span>Public demo role switch — not production access control.</span>
      </div>
      <form action="/api/demo/switch-role" method="post">
        <input name="csrfToken" type="hidden" value={csrfToken} />
        <input name="targetRole" type="hidden" value={targetRole} />
        <button type="submit">Switch to {targetLabel} role</button>
      </form>
    </aside>
  );
}
