"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parseHandoffClientResponse } from "@/features/claims/pickup-pass-client-response";

function clearPassword(input: HTMLInputElement | null): void {
  if (input) input.value = "";
}

export function StaffHandoffForm(props: {
  claimId: string;
  claimVersion: number;
  itemVersion: number;
  reportVersion: number;
  generation: number;
  csrfToken: string;
  fetcher?: typeof fetch;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    const clear = () => clearPassword(inputRef.current);
    clear();
    window.addEventListener("pageshow", clear);
    window.addEventListener("pagehide", clear);
    window.addEventListener("popstate", clear);
    return () => {
      clear();
      window.removeEventListener("pageshow", clear);
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("popstate", clear);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = inputRef.current?.value ?? "";
    const body = new URLSearchParams({
      token,
      expectedClaimVersion: String(props.claimVersion),
      expectedItemVersion: String(props.itemVersion),
      expectedReportVersion: String(props.reportVersion),
      expectedGeneration: String(props.generation),
      idempotencyKey,
    });
    clearPassword(inputRef.current);
    setMessage("Completing atomic handoff…");
    try {
      const response = await (props.fetcher ?? fetch)(
        `/api/staff/claims/${props.claimId}/handoff`,
        {
          method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-CSRF-Token": props.csrfToken,
          },
          body,
        },
      );
      if (!response.ok) {
        setMessage("Credential denied or state changed. Reload before another handoff attempt.");
        return;
      }
      const text = await response.text();
      if (text.length > 1_024) throw new Error("invalid handoff response");
      parseHandoffClientResponse(JSON.parse(text) as unknown, {
        claimId: props.claimId,
        currentClaimVersion: props.claimVersion,
        currentItemVersion: props.itemVersion,
        currentReportVersion: props.reportVersion,
        expectedGeneration: props.generation,
      });
      router.push(`/staff/claims/${props.claimId}`);
      router.refresh();
    } catch {
      setMessage("Invalid handoff response or connection failure. The credential field remains empty; reload before retrying.");
    } finally {
      clearPassword(inputRef.current);
    }
  }

  return (
    <form className="staff-handoff" aria-label="Staff pickup handoff" onSubmit={submit}>
      <h2>Complete pickup handoff</h2>
      <p>Success returns the item, resolves the lost report, and permanently consumes this credential.</p>
      <label>One-time pickup credential
        <input
          ref={inputRef}
          type="password"
          name="token"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          required
        />
      </label>
      <button type="submit">Confirm atomic handoff</button>
      {message && <p className="workspace-state" role="status">{message}</p>}
    </form>
  );
}
