"use client";

import { useEffect, useRef, useState } from "react";
import type { BrowserCandidateDto } from "@/features/reports/report-types";
import { candidateSearchSchema } from "@/features/reports/candidate-response-schema";
import { CandidateCard } from "./candidate-card";
import { useWebMcpCandidatePublisher } from "./webmcp-provider";

export interface CandidateFinderProps {
  reportId: string;
  reportVersion?: number;
  fetcher?: typeof fetch;
  className?: string;
}

type FinderState = Readonly<{
  scopeKey: string;
  candidates: readonly BrowserCandidateDto[];
  message: string;
  busy: boolean;
  error?: string;
}>;

function idleState(scopeKey: string): FinderState {
  return {
    scopeKey,
    candidates: [],
    message: "Candidates are loaded only when you ask.",
    busy: false,
  };
}

export function CandidateFinder({ reportId, reportVersion, fetcher = fetch, className = "" }: CandidateFinderProps) {
  const scopeKey = `${reportId}:${reportVersion ?? "unknown"}`;
  const [stored, setStored] = useState<FinderState>(() => idleState(scopeKey));
  const state = stored.scopeKey === scopeKey ? stored : idleState(scopeKey);
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | undefined>(undefined);
  const publishCandidates = useWebMcpCandidatePublisher();

  useEffect(() => () => {
    requestGeneration.current += 1;
    activeController.current?.abort();
    activeController.current = undefined;
  }, [scopeKey]);

  async function findCandidates() {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const generation = ++requestGeneration.current;
    const isCurrent = () => !controller.signal.aborted && requestGeneration.current === generation;
    setStored({ ...idleState(scopeKey), busy: true });
    try {
      const response = await fetcher(`/api/reports/${reportId}/matches?limit=3`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("request failed");
      const parsed = candidateSearchSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("invalid response");
      if (!isCurrent()) return;
      setStored({
        scopeKey,
        candidates: parsed.data.candidates,
        message: parsed.data.message,
        busy: true,
      });
      publishCandidates(reportId, parsed.data.reportVersion, parsed.data.candidates);
    } catch {
      if (!isCurrent()) return;
      if (reportVersion !== undefined) publishCandidates(reportId, reportVersion, []);
      setStored({
        ...idleState(scopeKey),
        busy: true,
        error: "Candidates could not be loaded. Please wait and try again.",
      });
    } finally {
      if (isCurrent()) {
        setStored((current) => current.scopeKey === scopeKey
          ? { ...current, busy: false }
          : current);
      }
    }
  }

  return (
    <section className={`candidate-finder ${className}`.trim()} aria-labelledby="candidate-finder-title" aria-busy={state.busy}>
      <div className="candidate-finder-heading">
        <div>
          <p className="workspace-kicker">Step 02 · Match</p>
          <h2 id="candidate-finder-title">Privacy-safe candidates</h2>
        </div>
        <button type="button" onClick={findCandidates} disabled={state.busy}>
          {state.busy ? "Searching…" : "Find candidates"}
        </button>
      </div>
      {state.error ? <p className="workspace-state error-state" role="alert">{state.error}</p> : (
        <p className="candidate-message" role="status" aria-live="polite">{state.message}</p>
      )}
      {state.candidates.length > 0 && (
        <div className="candidate-grid">{state.candidates.map((candidate) => (
          <CandidateCard candidate={candidate} key={candidate.candidateHandle} />
        ))}</div>
      )}
    </section>
  );
}
