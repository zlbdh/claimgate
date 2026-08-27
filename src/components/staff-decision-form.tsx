"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ClaimStatus } from "@/features/claims/claim-state";

type Action = "approve" | "reject" | "unlock";

export function StaffDecisionForm(props: {
  claimId: string;
  status: ClaimStatus;
  claimVersion: number;
  itemVersion: number;
  unlockCount: number;
  approveCsrfToken?: string;
  rejectCsrfToken?: string;
  unlockCsrfToken?: string;
  fetcher?: typeof fetch;
}) {
  const router = useRouter();
  const [keys] = useState(() => ({
    approve: crypto.randomUUID(), reject: crypto.randomUUID(), unlock: crypto.randomUUID(),
  }));
  const [message, setMessage] = useState<string>();
  const fetcher = props.fetcher ?? fetch;

  async function submit(action: Action, token: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = new URLSearchParams({
      expectedClaimVersion: String(props.claimVersion),
      idempotencyKey: keys[action],
    });
    if (action === "approve") body.set("expectedItemVersion", String(props.itemVersion));
    try {
      const response = await fetcher(`/api/staff/claims/${props.claimId}/${action}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-CSRF-Token": token,
        },
        body,
      });
      if (!response.ok) return setMessage("The claim changed or the action was denied. Reload to review it.");
      router.push(`/staff/claims/${props.claimId}`);
      router.refresh();
    } catch {
      setMessage("The connection failed. Reload before retrying this decision.");
    }
  }

  return (
    <section className="staff-decisions" aria-labelledby="staff-decisions-title">
      <h2 id="staff-decisions-title">Staff decision</h2>
      {props.status === "UNDER_REVIEW" && props.approveCsrfToken && props.rejectCsrfToken && <>
        <p>This holds the item and rejects every competing claim; their reports remain open.</p>
        <form onSubmit={(event) => submit("approve", props.approveCsrfToken!, event)}>
          <button type="submit">Approve claim</button>
        </form>
        <form onSubmit={(event) => submit("reject", props.rejectCsrfToken!, event)}>
          <button className="quiet-action" type="submit">Reject claim</button>
        </form>
      </>}
      {props.status === "LOCKED" && props.unlockCount === 0 && props.unlockCsrfToken && (
        <form onSubmit={(event) => submit("unlock", props.unlockCsrfToken!, event)}>
          <p>Unlock claim once and reset failed attempts to zero.</p>
          <button type="submit">Unlock claim</button>
        </form>
      )}
      {message && <p className="workspace-state" role="status">{message}</p>}
    </section>
  );
}
