"use client";

import { useState } from "react";
import { z } from "zod";
import type { BrowserCandidateDto } from "@/features/reports/report-types";
import { CandidateCard } from "./candidate-card";

const candidateSchema = z.strictObject({
  candidateHandle: z.string().regex(/^cgch1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.[A-Za-z0-9_-]{43}$/),
  category: z.string().min(1).max(64),
  timeBand: z.string().min(1).max(64),
  area: z.string().min(1).max(64),
  color: z.string().min(1).max(64),
  confidence: z.enum(["strong", "possible", "weak"]),
  reasons: z.array(z.string().min(1).max(160)).max(8),
  expiresAt: z.number().int().safe().positive(),
});
const responseSchema = z.strictObject({
  candidates: z.array(candidateSchema).max(3),
  message: z.string().min(1).max(256),
});

export interface CandidateFinderProps {
  reportId: string;
  fetcher?: typeof fetch;
  className?: string;
}

export function CandidateFinder({ reportId, fetcher = fetch, className = "" }: CandidateFinderProps) {
  const [candidates, setCandidates] = useState<BrowserCandidateDto[]>([]);
  const [message, setMessage] = useState("Candidates are loaded only when you ask.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function findCandidates() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetcher(`/api/reports/${reportId}/matches?limit=3`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("request failed");
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("invalid response");
      setCandidates(parsed.data.candidates);
      setMessage(parsed.data.message);
    } catch {
      setCandidates([]);
      setError("Candidates could not be loaded. Please wait and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`candidate-finder ${className}`.trim()} aria-labelledby="candidate-finder-title" aria-busy={busy}>
      <div className="candidate-finder-heading">
        <div>
          <p className="workspace-kicker">Step 02 · Match</p>
          <h2 id="candidate-finder-title">Privacy-safe candidates</h2>
        </div>
        <button type="button" onClick={findCandidates} disabled={busy}>
          {busy ? "Searching…" : "Find candidates"}
        </button>
      </div>
      {error ? <p className="workspace-state error-state" role="alert">{error}</p> : (
        <p className="candidate-message" role="status" aria-live="polite">{message}</p>
      )}
      {candidates.length > 0 && (
        <div className="candidate-grid">{candidates.map((candidate) => (
          <CandidateCard candidate={candidate} key={candidate.candidateHandle} />
        ))}</div>
      )}
    </section>
  );
}
