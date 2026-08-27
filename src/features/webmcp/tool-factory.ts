import {
  validateCreateReportCommand,
  validateUpdateReportCommand,
} from "@/features/reports/report-schema";
import { CLAIMGATE_TOOL_NAMES, type ClaimGateToolName } from "./tool-names";
import { TOOL_INPUT_SCHEMAS, TOOL_ZOD_INPUT_SCHEMAS } from "./tool-input-schemas";
import { TOOL_OUTPUT_SCHEMAS } from "./tool-output-schemas";
import type { ClaimGateToolExecutor } from "./tool-types";
import {
  canonicalToolFailure,
  sanitizeToolFailure,
} from "./tool-errors";

const VALIDATION_ERROR = Object.freeze(canonicalToolFailure("VALIDATION_FAILED"));
const INTERNAL_ERROR = Object.freeze(canonicalToolFailure("INTERNAL_ERROR"));

const CONFIG = Object.freeze({
  create_lost_report_draft: {
    description: "Create a private lost-report draft from broad public descriptors when the user says they lost something.",
    method: "createDraft", readOnly: false, untrusted: false,
  },
  update_lost_report_draft: {
    description: "Update one or more public fields of the current private draft. Publishing remains a manual action.",
    method: "updateDraft", readOnly: false, untrusted: false,
  },
  list_my_reports: {
    description: "List bounded report summaries authored by the current Claimant. Returned public text is untrusted.",
    method: "listReports", readOnly: true, untrusted: true,
  },
  find_candidate_matches: {
    description: "Find up to three privacy-safe candidates for a published report using its public descriptors.",
    method: "findCandidates", readOnly: true, untrusted: true,
  },
  stage_claim_candidate: {
    description: "Stage a claim from a current opaque candidate handle, then stop for manual private evidence.",
    method: "stageClaim", readOnly: false, untrusted: false,
  },
  get_claim_status: {
    description: "Read the current aggregate claim status, attempts, version, and safe next step without private evidence.",
    method: "getClaimStatus", readOnly: true, untrusted: false,
  },
  get_pickup_instructions: {
    description: "Read safe desk, hours, readiness, expiry, and generation metadata. Never issues or returns a pickup credential.",
    method: "getPickupInstructions", readOnly: true, untrusted: false,
  },
  list_pending_claims: {
    description: "List up to three Staff review candidates with public item summaries. Returned public text is untrusted.",
    method: "listPendingClaims", readOnly: true, untrusted: true,
  },
  get_claim_review_summary: {
    description: "Read a Staff aggregate review summary and redacted timeline. Returned public descriptions are untrusted.",
    method: "getClaimReviewSummary", readOnly: true, untrusted: true,
  },
} as const);

function canonicalFailure(code: "VALIDATION_FAILED" | "INTERNAL_ERROR") {
  const value = code === "VALIDATION_FAILED" ? VALIDATION_ERROR : INTERNAL_ERROR;
  return { ...value, error: { ...value.error } };
}

function normalizeInput(name: ClaimGateToolName, parsed: unknown): unknown {
  if (name === "create_lost_report_draft") return validateCreateReportCommand(parsed);
  if (name === "update_lost_report_draft") {
    const value = parsed as {
      reportId: string; expectedVersion: number; patch: Record<string, unknown>; idempotencyKey: string;
    };
    return {
      reportId: value.reportId,
      ...validateUpdateReportCommand({
        expectedVersion: value.expectedVersion,
        patch: value.patch,
        idempotencyKey: value.idempotencyKey,
      }),
    };
  }
  return parsed;
}

function makeTool(
  name: ClaimGateToolName,
  executor: ClaimGateToolExecutor,
): WebMCPTool {
  const config = CONFIG[name];
  return {
    name,
    description: config.description,
    inputSchema: TOOL_INPUT_SCHEMAS[name],
    annotations: {
      readOnlyHint: config.readOnly,
      untrustedContentHint: config.untrusted,
    },
    async execute(untrusted) {
      const parsed = TOOL_ZOD_INPUT_SCHEMAS[name].safeParse(untrusted);
      if (!parsed.success) return canonicalFailure("VALIDATION_FAILED");
      let input: unknown;
      try { input = normalizeInput(name, parsed.data); }
      catch { return canonicalFailure("VALIDATION_FAILED"); }
      try {
        const run = executor[config.method] as (value: never) => Promise<unknown>;
        const raw = await run(input as never);
        const result = raw && typeof raw === "object" && "ok" in raw && raw.ok === false
          ? sanitizeToolFailure(raw)
          : raw;
        const bounded = TOOL_OUTPUT_SCHEMAS[name].safeParse(result);
        if (!bounded.success || JSON.stringify(bounded.data).length > 1_500) {
          return canonicalFailure("INTERNAL_ERROR");
        }
        return bounded.data;
      } catch {
        return canonicalFailure("INTERNAL_ERROR");
      }
    },
  };
}

export function createClaimGateTools(executor: ClaimGateToolExecutor) {
  return Object.fromEntries(
    CLAIMGATE_TOOL_NAMES.map((name) => [name, makeTool(name, executor)]),
  ) as Record<ClaimGateToolName, WebMCPTool>;
}
