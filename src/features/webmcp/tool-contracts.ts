import { z } from "zod";
import { validateCreateReportCommand } from "@/features/reports/report-schema";
import {
  TOOL_ERROR_CODES,
  TOOL_ERROR_MESSAGES,
  canonicalToolFailure,
  sanitizeToolFailure,
  type CanonicalToolError,
} from "./tool-errors";

export const CLAIMGATE_TOOL_NAMES = Object.freeze([
  "create_lost_report_draft",
  "list_my_reports",
  "find_candidate_matches",
  "stage_claim_candidate",
] as const);

export type ClaimGateToolName = (typeof CLAIMGATE_TOOL_NAMES)[number];

const publicText = z.string().min(1).max(64);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/);
const candidateHandle = z.string().max(96).regex(
  /^cgch1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.[A-Za-z0-9_-]{43}$/,
);

const createInput = z.strictObject({
  category: publicText,
  timeWindow: z.strictObject({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
  }),
  area: publicText,
  color: publicText,
  publicTags: z.array(publicText).max(8),
  publicDescription: z.string().min(1).max(256),
  idempotencyKey,
});
const listInput = z.strictObject({
  status: z.enum(["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
const findInput = z.strictObject({
  reportId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  limit: z.number().int().min(1).max(3).optional(),
});
const stageInput = z.strictObject({
  reportId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  candidateHandle,
  expectedVersion: z.number().int().safe().positive(),
  idempotencyKey,
});

type CreateInput = z.infer<typeof createInput>;
type ListInput = z.infer<typeof listInput>;
type FindInput = z.infer<typeof findInput>;
type StageInput = z.infer<typeof stageInput>;

export type ToolResult<T> =
  | Readonly<{ ok: true; data: T; nextPath?: string }>
  | Readonly<{ ok: false; error: CanonicalToolError }>;

type CreateData = Readonly<{ reportId: string; status: "DRAFT"; version: number }>;
type ReportSummary = Readonly<{
  reportId: string;
  category: string;
  timeWindow: Readonly<{ from: string; to: string }>;
  area: string;
  color: string;
  status: "DRAFT" | "PUBLISHED" | "RESOLVED" | "ARCHIVED";
  version: number;
}>;
export type CandidateToolDto = Readonly<{
  candidateHandle: string;
  category: string;
  timeBand: string;
  area: string;
  color: string;
  confidence: "strong" | "possible" | "weak";
  reasons: readonly string[];
  expiresAt: number;
}>;
type FindData = Readonly<{
  reportVersion: number;
  candidates: readonly CandidateToolDto[];
  message: string;
}>;
type StageData = Readonly<{
  claimId: string;
  status: "EVIDENCE_REQUIRED";
  version: number;
  remainingAttempts: 3;
}>;

export type ClaimGateToolExecutor = Readonly<{
  createDraft(input: CreateInput): Promise<ToolResult<CreateData>>;
  listReports(input: ListInput): Promise<ToolResult<{ reports: readonly ReportSummary[] }>>;
  findCandidates(input: FindInput): Promise<ToolResult<FindData>>;
  stageClaim(input: StageInput): Promise<ToolResult<StageData>>;
}>;

const errorSchema = z.strictObject({
  code: z.enum(TOOL_ERROR_CODES),
  message: z.string().min(1).max(256),
  retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
}).superRefine((value, context) => {
  if (value.message !== TOOL_ERROR_MESSAGES[value.code]) {
    context.addIssue({ code: "custom", path: ["message"], message: "Noncanonical tool message" });
  }
  if (value.code !== "RATE_LIMITED" && value.retryAfterSeconds !== undefined) {
    context.addIssue({ code: "custom", path: ["retryAfterSeconds"], message: "Unexpected retry metadata" });
  }
});
const reportSummarySchema = z.strictObject({
  reportId: z.string().min(1).max(128), category: publicText,
  timeWindow: z.strictObject({ from: z.string().max(64), to: z.string().max(64) }),
  area: publicText, color: publicText,
  status: z.enum(["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"]),
  version: z.number().int().safe().positive(),
});
const candidateSchema = z.strictObject({
  candidateHandle, category: publicText, timeBand: publicText, area: publicText, color: publicText,
  confidence: z.enum(["strong", "possible", "weak"]),
  reasons: z.array(z.string().min(1).max(160)).max(8),
  expiresAt: z.number().int().safe().positive(),
});
const outputSchemas = {
  create_lost_report_draft: z.union([
    z.strictObject({ ok: z.literal(true), data: z.strictObject({
      reportId: z.string().min(1).max(128), status: z.literal("DRAFT"),
      version: z.number().int().safe().positive(),
    }), nextPath: z.string().startsWith("/claimant/reports/").max(256).optional() }),
    z.strictObject({ ok: z.literal(false), error: errorSchema }),
  ]),
  list_my_reports: z.union([
    z.strictObject({ ok: z.literal(true), data: z.strictObject({ reports: z.array(reportSummarySchema).max(20) }), nextPath: z.never().optional() }),
    z.strictObject({ ok: z.literal(false), error: errorSchema }),
  ]),
  find_candidate_matches: z.union([
    z.strictObject({ ok: z.literal(true), data: z.strictObject({
      reportVersion: z.number().int().safe().positive(), candidates: z.array(candidateSchema).max(3),
      message: z.string().min(1).max(256),
    }), nextPath: z.never().optional() }),
    z.strictObject({ ok: z.literal(false), error: errorSchema }),
  ]),
  stage_claim_candidate: z.union([
    z.strictObject({ ok: z.literal(true), data: z.strictObject({
      claimId: z.string().min(1).max(128), status: z.literal("EVIDENCE_REQUIRED"),
      version: z.number().int().safe().positive(), remainingAttempts: z.literal(3),
    }), nextPath: z.string().startsWith("/claimant/claims/").max(256).optional() }),
    z.strictObject({ ok: z.literal(false), error: errorSchema }),
  ]),
} as const;

const schemas = {
  create_lost_report_draft: createInput,
  list_my_reports: listInput,
  find_candidate_matches: findInput,
  stage_claim_candidate: stageInput,
} as const;

export const TOOL_INPUT_SCHEMAS = Object.freeze({
  create_lost_report_draft: {
    type: "object", additionalProperties: false,
    required: ["category", "timeWindow", "area", "color", "publicTags", "publicDescription", "idempotencyKey"],
    properties: {
      category: { type: "string", minLength: 1, maxLength: 64 },
      timeWindow: { type: "object", additionalProperties: false, required: ["from", "to"], properties: {
        from: { type: "string", minLength: 1, maxLength: 64, format: "date-time" },
        to: { type: "string", minLength: 1, maxLength: 64, format: "date-time" },
      } },
      area: { type: "string", minLength: 1, maxLength: 64 },
      color: { type: "string", minLength: 1, maxLength: 64 },
      publicTags: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 64 } },
      publicDescription: { type: "string", minLength: 1, maxLength: 256 },
      idempotencyKey: { type: "string", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$" },
    },
  },
  list_my_reports: {
    type: "object", additionalProperties: false, required: [], properties: {
      status: { type: "string", enum: ["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"] },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
  },
  find_candidate_matches: {
    type: "object", additionalProperties: false, required: ["reportId"], properties: {
      reportId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" },
      limit: { type: "integer", minimum: 1, maximum: 3 },
    },
  },
  stage_claim_candidate: {
    type: "object", additionalProperties: false,
    required: ["reportId", "candidateHandle", "expectedVersion", "idempotencyKey"],
    properties: {
      reportId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" },
      candidateHandle: { type: "string", maxLength: 96, pattern: "^cgch1\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.[A-Za-z0-9_-]{43}$" },
      expectedVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      idempotencyKey: { type: "string", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$" },
    },
  },
} as const);

const VALIDATION_ERROR = Object.freeze(canonicalToolFailure("VALIDATION_FAILED"));
const INTERNAL_ERROR = Object.freeze(canonicalToolFailure("INTERNAL_ERROR"));

function makeTool(
  name: ClaimGateToolName,
  description: string,
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean },
  run: (input: never) => Promise<unknown>,
): WebMCPTool {
  return {
    name, description, inputSchema: TOOL_INPUT_SCHEMAS[name], annotations,
    async execute(untrusted) {
      const parsed = schemas[name].safeParse(untrusted);
      if (!parsed.success) return { ...VALIDATION_ERROR, error: { ...VALIDATION_ERROR.error } };
      let input: unknown = parsed.data;
      if (name === "create_lost_report_draft") {
        try {
          input = validateCreateReportCommand(parsed.data);
        } catch {
          return { ...VALIDATION_ERROR, error: { ...VALIDATION_ERROR.error } };
        }
      }
      try {
        const raw = await run(input as never);
        const result = raw && typeof raw === "object" && "ok" in raw && raw.ok === false
          ? sanitizeToolFailure(raw)
          : raw;
        const bounded = outputSchemas[name].safeParse(result);
        if (!bounded.success || JSON.stringify(bounded.data).length > 32_768) {
          return { ...INTERNAL_ERROR, error: { ...INTERNAL_ERROR.error } };
        }
        return bounded.data;
      } catch {
        return { ...INTERNAL_ERROR, error: { ...INTERNAL_ERROR.error } };
      }
    },
  };
}

export function createClaimGateTools(executor: ClaimGateToolExecutor) {
  return {
    create_lost_report_draft: makeTool(
      "create_lost_report_draft", "Create a private lost-report draft from public descriptors.",
      { readOnlyHint: false, untrustedContentHint: false }, executor.createDraft,
    ),
    list_my_reports: makeTool(
      "list_my_reports", "List the current Claimant's bounded report summaries.",
      { readOnlyHint: true, untrustedContentHint: true }, executor.listReports,
    ),
    find_candidate_matches: makeTool(
      "find_candidate_matches", "Find up to three privacy-safe candidates for a published report.",
      { readOnlyHint: true, untrustedContentHint: true }, executor.findCandidates,
    ),
    stage_claim_candidate: makeTool(
      "stage_claim_candidate", "Stage an evidence-required claim from a current opaque candidate handle.",
      { readOnlyHint: false, untrustedContentHint: false }, executor.stageClaim,
    ),
  } satisfies Record<ClaimGateToolName, WebMCPTool>;
}
