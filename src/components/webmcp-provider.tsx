"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { createActivityStore, type ActivityStateChange } from "@/features/webmcp/activity-store";
import { resolveModelContext } from "@/features/webmcp/model-context";
import { createClaimGateTools, type CandidateToolDto, type ClaimGateToolExecutor, type ClaimGateToolName } from "@/features/webmcp/tool-contracts";
import { createToolExecutor } from "@/features/webmcp/tool-executor";
import { createToolRegistrationManager, type RegistrationState } from "@/features/webmcp/tool-registration";
import { toolNamesForScope, type ClaimGateToolScope } from "@/features/webmcp/tool-registry";
import { AgentActivity } from "./agent-activity";

type PageRegistration = Readonly<{
  id: symbol;
  scope: ClaimGateToolScope;
  createCsrfToken?: string;
  updateCsrfToken?: string;
  stageCsrfToken?: string;
}>;
type CandidateState = Readonly<{
  reportId: string;
  reportVersion: number;
  candidates: readonly CandidateToolDto[];
}>;
type ActivePageRegistration = PageRegistration & Readonly<{ generation: number }>;
type ProviderContextValue = Readonly<{
  mount(value: PageRegistration): void;
  unmount(id: symbol): void;
  publishCandidates(reportId: string, reportVersion: number, candidates: readonly CandidateToolDto[]): void;
  clearCandidates(reportId: string): void;
}>;

const ProviderContext = createContext<ProviderContextValue | undefined>(undefined);
const noopPublish: ProviderContextValue["publishCandidates"] = () => undefined;

function createPageGenerationGate() {
  let generation = 0;
  let current: ActivePageRegistration | undefined;
  return Object.freeze({
    activate(value: PageRegistration) {
      current = { ...value, generation: ++generation };
      return current;
    },
    invalidate(id: symbol) {
      if (current?.id !== id) return undefined;
      const invalidated = current;
      generation += 1;
      current = undefined;
      return invalidated;
    },
    current: () => current,
    isCurrent: (value: number) => current?.generation === value,
  });
}

function withActivity(
  executor: ClaimGateToolExecutor,
  store: ReturnType<typeof createActivityStore>,
  isCurrent: () => boolean,
): ClaimGateToolExecutor {
  const wrap = <T extends keyof ClaimGateToolExecutor>(
    name: ClaimGateToolName,
    method: T,
    successChange: ActivityStateChange,
  ): ClaimGateToolExecutor[T] => (async (input: never) => {
    const finish = store.begin(name);
    const result = await executor[method](input);
    if (!isCurrent()) return result;
    finish({
      success: result.ok,
      errorCode: result.ok ? undefined : result.error.code,
      stateChange: result.ok ? successChange : "No page change",
    });
    return result;
  }) as ClaimGateToolExecutor[T];
  return Object.freeze({
    createDraft: wrap("create_lost_report_draft", "createDraft", "Draft page opened"),
    updateDraft: wrap("update_lost_report_draft", "updateDraft", "Draft updated"),
    listReports: wrap("list_my_reports", "listReports", "No page change"),
    findCandidates: wrap("find_candidate_matches", "findCandidates", "Candidate state updated"),
    stageClaim: wrap("stage_claim_candidate", "stageClaim", "Claim checkpoint opened"),
    getClaimStatus: wrap("get_claim_status", "getClaimStatus", "Claim status read"),
    getPickupInstructions: wrap(
      "get_pickup_instructions", "getPickupInstructions", "Pickup instructions read",
    ),
    listPendingClaims: wrap("list_pending_claims", "listPendingClaims", "Pending queue read"),
    getClaimReviewSummary: wrap(
      "get_claim_review_summary", "getClaimReviewSummary", "Review summary read",
    ),
  });
}

export function WebMcpProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const activity = useMemo(() => createActivityStore(), []);
  const generationGate = useMemo(() => createPageGenerationGate(), []);
  const [registration, setRegistration] = useState<ActivePageRegistration>();
  const [candidates, setCandidates] = useState<CandidateState>();
  const [status, setStatus] = useState<RegistrationState | "unsupported">("unsupported");

  const publishCandidates = useCallback<ProviderContextValue["publishCandidates"]>(
    (reportId, reportVersion, nextCandidates) => {
      const current = generationGate.current();
      if (
        current?.scope.page === "REPORT"
        && current.scope.reportId === reportId
        && current.scope.reportVersion === reportVersion
      ) setCandidates({ reportId, reportVersion, candidates: [...nextCandidates] });
    },
    [generationGate],
  );
  const clearCandidates = useCallback<ProviderContextValue["clearCandidates"]>((reportId) => {
    const current = generationGate.current();
    if (current?.scope.page === "REPORT" && current.scope.reportId === reportId) {
      setCandidates(undefined);
    }
  }, [generationGate]);

  const mount = useCallback((value: PageRegistration) => {
    const next = generationGate.activate(value);
    setCandidates(undefined);
    setRegistration(next);
  }, [generationGate]);
  const unmount = useCallback((id: symbol) => {
    const current = generationGate.invalidate(id);
    if (!current) return;
    setCandidates(undefined);
    setRegistration((registered) => registered?.generation === current.generation ? undefined : registered);
  }, [generationGate]);

  const contextValue = useMemo<ProviderContextValue>(() => ({
    mount,
    unmount,
    publishCandidates,
    clearCandidates,
  }), [clearCandidates, mount, publishCandidates, unmount]);

  const effectiveScope = useMemo<ClaimGateToolScope | undefined>(() => {
    if (!registration) return undefined;
    if (
      registration.scope.page === "REPORT"
      && candidates?.reportId === registration.scope.reportId
    ) return {
      ...registration.scope,
      candidateReportVersion: candidates.reportVersion,
      candidateCount: candidates.candidates.length,
    };
    return registration.scope;
  }, [registration, candidates]);

  const tools = useMemo(() => {
    if (!registration || !effectiveScope) return [];
    const base = createToolExecutor({
      createCsrfToken: registration.createCsrfToken,
      updateCsrfToken: registration.updateCsrfToken,
      stageCsrfToken: registration.stageCsrfToken,
      navigate: (path) => { router.push(path); router.refresh(); },
      refresh: () => router.refresh(),
      publishCandidates,
      clearCandidates,
      isCurrent: () => generationGate.isCurrent(registration.generation),
    });
    const all = createClaimGateTools(withActivity(
      base, activity, () => generationGate.isCurrent(registration.generation),
    ));
    return toolNamesForScope(effectiveScope).map((name) => all[name]);
  }, [activity, clearCandidates, effectiveScope, generationGate, publishCandidates, registration, router]);

  useEffect(() => {
    const resolved = resolveModelContext(document);
    if (!resolved.supported) return;
    const manager = createToolRegistrationManager(resolved.context, setStatus);
    void manager.replace(tools);
    return () => manager.dispose();
  }, [tools]);

  return (
    <ProviderContext.Provider value={contextValue}>
      {children}
      <AgentActivity store={activity} status={status} />
    </ProviderContext.Provider>
  );
}

export function WebMcpPageScope({
  scope,
  createCsrfToken,
  updateCsrfToken,
  stageCsrfToken,
}: {
  scope: ClaimGateToolScope;
  createCsrfToken?: string;
  updateCsrfToken?: string;
  stageCsrfToken?: string;
}) {
  const provider = useContext(ProviderContext);
  const [id] = useState(() => Symbol("WebMcpPageScope"));
  const serializedScope = JSON.stringify(scope);
  const stableScope = useMemo(
    () => JSON.parse(serializedScope) as ClaimGateToolScope,
    [serializedScope],
  );
  useEffect(() => {
    if (!provider) return;
    provider.mount({ id, scope: stableScope, createCsrfToken, updateCsrfToken, stageCsrfToken });
    return () => provider.unmount(id);
  }, [provider, id, stableScope, createCsrfToken, updateCsrfToken, stageCsrfToken]);
  return null;
}

export function useWebMcpCandidatePublisher() {
  return useContext(ProviderContext)?.publishCandidates ?? noopPublish;
}
