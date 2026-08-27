"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const FIELDS = [
  ["unique_mark", "Private evidence · unique mark"],
  ["contents_or_accessory", "Private evidence · contents or accessory"],
  ["identifier_suffix", "Private evidence · identifier suffix"],
] as const;

export function EvidenceForm({
  claimId,
  csrfToken,
  expectedVersion,
  fetcher = fetch,
}: {
  claimId: string;
  csrfToken: string;
  expectedVersion: number;
  fetcher?: typeof fetch;
}) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new URLSearchParams({
      expectedVersion: String(expectedVersion),
      idempotencyKey,
    });
    for (const [name] of FIELDS) {
      const input = form.elements.namedItem(name) as HTMLInputElement;
      body.set(name, input.value);
      input.value = "";
    }
    setMessage("Checking aggregate evidence…");
    try {
      const response = await fetcher(`/api/claims/${claimId}/evidence`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-CSRF-Token": csrfToken,
        },
        body,
      });
      if (!response.ok) {
        setMessage("The evidence result could not be applied. Reload and try again.");
        return;
      }
      router.push(`/claimant/claims/${claimId}`);
      router.refresh();
    } catch {
      setMessage("The connection failed. Your evidence fields remain empty; reload before retrying.");
    }
  }

  return (
    <form className="report-form evidence-form" aria-label="Private evidence" onSubmit={submit}>
      <p className="panel-copy">
        Enter up to three private facts. Only an aggregate result is retained; individual answers are not stored.
      </p>
      <div className="form-grid">
        {FIELDS.map(([name, label]) => (
          <label className="wide-field" key={name}>{label}
            <input
              type="password"
              name={name}
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
            />
          </label>
        ))}
      </div>
      <button type="submit">Submit private evidence</button>
      {message && <p className="workspace-state" role="status">{message}</p>}
    </form>
  );
}
