import { z } from "zod";
import {
  CANDIDATE_HANDLE_MAX_LENGTH,
  CANDIDATE_HANDLE_PATTERN_SOURCE,
  candidateHandleSchema,
} from "@/features/matching/candidate-handle-syntax";

const publicText = z.string().min(1).max(64);
const publicDescription = z.string().min(1).max(256);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const version = z.number().int().safe().positive();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/);
const timeWindow = z.strictObject({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
});
const patch = z.strictObject({
  category: publicText.optional(),
  timeWindow: timeWindow.optional(),
  area: publicText.optional(),
  color: publicText.optional(),
  publicTags: z.array(publicText).max(8).optional(),
  publicDescription: publicDescription.optional(),
}).refine((value) => Object.keys(value).length > 0);

export const TOOL_ZOD_INPUT_SCHEMAS = Object.freeze({
  create_lost_report_draft: z.strictObject({
    category: publicText, timeWindow, area: publicText, color: publicText,
    publicTags: z.array(publicText).max(8), publicDescription, idempotencyKey,
  }),
  update_lost_report_draft: z.strictObject({
    reportId: id, expectedVersion: version, patch, idempotencyKey,
  }),
  list_my_reports: z.strictObject({
    status: z.enum(["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"]).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  find_candidate_matches: z.strictObject({
    reportId: id, limit: z.number().int().min(1).max(3).optional(),
  }),
  stage_claim_candidate: z.strictObject({
    reportId: id, candidateHandle: candidateHandleSchema,
    expectedVersion: version, idempotencyKey,
  }),
  get_claim_status: z.strictObject({ claimId: id }),
  get_pickup_instructions: z.strictObject({ claimId: id }),
  list_pending_claims: z.strictObject({ limit: z.number().int().min(1).max(3).optional() }),
  get_claim_review_summary: z.strictObject({ claimId: id }),
});

export type ToolInputMap = {
  [Name in keyof typeof TOOL_ZOD_INPUT_SCHEMAS]: z.infer<(typeof TOOL_ZOD_INPUT_SCHEMAS)[Name]>;
};

const idJson = {
  type: "string", minLength: 1, maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  description: "Public resource identifier.",
} as const;
const versionJson = {
  type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
  description: "Expected public resource version.",
} as const;
const idempotencyJson = {
  type: "string", minLength: 16, maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$",
  description: "Stable key for one intended write.",
} as const;
const textJson = (description: string) => ({
  type: "string", minLength: 1, maxLength: 64, description,
} as const);
const timeWindowJson = {
  type: "object", additionalProperties: false, required: ["from", "to"],
  description: "Inclusive public loss time window.",
  properties: {
    from: { type: "string", minLength: 1, maxLength: 64, format: "date-time", description: "Window start in ISO date-time form." },
    to: { type: "string", minLength: 1, maxLength: 64, format: "date-time", description: "Window end in ISO date-time form." },
  },
} as const;
const reportFieldsJson = {
  category: textJson("Broad public item category."),
  timeWindow: timeWindowJson,
  area: textJson("Broad public location area."),
  color: textJson("Broad public item color."),
  publicTags: { type: "array", maxItems: 8, description: "Public descriptors only.",
    items: { type: "string", minLength: 1, maxLength: 64 } },
  publicDescription: { type: "string", minLength: 1, maxLength: 256,
    description: "Public description without private proof." },
} as const;

export const TOOL_INPUT_SCHEMAS = Object.freeze({
  create_lost_report_draft: {
    type: "object", additionalProperties: false,
    required: ["category", "timeWindow", "area", "color", "publicTags", "publicDescription", "idempotencyKey"],
    properties: { ...reportFieldsJson, idempotencyKey: idempotencyJson },
  },
  update_lost_report_draft: {
    type: "object", additionalProperties: false,
    required: ["reportId", "expectedVersion", "patch", "idempotencyKey"],
    properties: {
      reportId: idJson, expectedVersion: versionJson, idempotencyKey: idempotencyJson,
      patch: { type: "object", additionalProperties: false, minProperties: 1,
        description: "One or more public draft fields to replace.", properties: reportFieldsJson },
    },
  },
  list_my_reports: { type: "object", additionalProperties: false, required: [], properties: {
    status: { type: "string", enum: ["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"], description: "Optional report status filter." },
    limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum report count." },
  } },
  find_candidate_matches: { type: "object", additionalProperties: false, required: ["reportId"], properties: {
    reportId: idJson, limit: { type: "integer", minimum: 1, maximum: 3, description: "Maximum candidate count." },
  } },
  stage_claim_candidate: { type: "object", additionalProperties: false,
    required: ["reportId", "candidateHandle", "expectedVersion", "idempotencyKey"], properties: {
      reportId: idJson,
      candidateHandle: { type: "string", maxLength: CANDIDATE_HANDLE_MAX_LENGTH,
        pattern: CANDIDATE_HANDLE_PATTERN_SOURCE, description: "Current opaque candidate handle." },
      expectedVersion: versionJson, idempotencyKey: idempotencyJson,
    } },
  get_claim_status: { type: "object", additionalProperties: false, required: ["claimId"], properties: { claimId: idJson } },
  get_pickup_instructions: { type: "object", additionalProperties: false, required: ["claimId"], properties: { claimId: idJson } },
  list_pending_claims: { type: "object", additionalProperties: false, required: [], properties: {
    limit: { type: "integer", minimum: 1, maximum: 3, description: "Maximum pending claim count." },
  } },
  get_claim_review_summary: { type: "object", additionalProperties: false, required: ["claimId"], properties: { claimId: idJson } },
} as const);
