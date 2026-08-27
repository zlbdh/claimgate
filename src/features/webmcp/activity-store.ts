import type { ClaimGateToolName } from "./tool-contracts";

const SAFE_ERROR_CODES = new Set([
  "AUTH_REQUIRED", "FORBIDDEN", "VALIDATION_FAILED", "STATE_CHANGED", "NOT_FOUND",
  "RATE_LIMITED", "ITEM_UNAVAILABLE", "CONFLICT", "INVALID_STATE_TRANSITION",
  "CONFIGURATION_ERROR", "INTERNAL_ERROR",
]);

export type ActivityStateChange =
  | "Draft page opened"
  | "Candidate state updated"
  | "Claim checkpoint opened"
  | "No page change";

export type AgentActivityEntry = Readonly<{
  name: ClaimGateToolName;
  startedAt: number;
  endedAt: number;
  success: boolean;
  errorCode: string | undefined;
  stateChange: ActivityStateChange;
}>;

export function createActivityStore(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let entries: AgentActivityEntry[] = [];
  const listeners = new Set<() => void>();

  return Object.freeze({
    begin(name: ClaimGateToolName) {
      const startedAt = now();
      return (result: {
        success: boolean;
        errorCode?: string;
        stateChange: ActivityStateChange;
      }) => {
        const entry = Object.freeze({
          name,
          startedAt,
          endedAt: now(),
          success: result.success,
          errorCode: result.errorCode === undefined
            ? undefined
            : SAFE_ERROR_CODES.has(result.errorCode) ? result.errorCode : "INTERNAL_ERROR",
          stateChange: result.stateChange,
        });
        entries = [...entries, entry].slice(-20);
        listeners.forEach((listener) => listener());
      };
    },
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export type ActivityStore = ReturnType<typeof createActivityStore>;
