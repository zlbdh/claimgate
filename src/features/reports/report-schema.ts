import { z } from "zod";
import { DomainError } from "@/shared/domain-error";
import type { LostReport } from "@/features/matching/score-candidate";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;
const PUBLIC_TOKEN = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/;
const CANONICAL_INTEGER = /^[1-9][0-9]*$/;
const DASHES = /[-‐‑‒–—―]/g;
const CONTROLS = /[\u0000-\u001f\u007f]/;

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function normalizeToken(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(DASHES, "-").replace(/\s+/g, " ");
}

function normalizeDescription(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

const rawTokenSchema = z.string().min(1).max(128)
  .refine((value) => isWellFormed(value) && !CONTROLS.test(value))
  .transform(normalizeToken)
  .pipe(z.string().min(1).max(64).regex(PUBLIC_TOKEN));

const descriptionSchema = z.string().min(1).max(512)
  .refine((value) => isWellFormed(value) && !CONTROLS.test(value))
  .transform(normalizeDescription)
  .pipe(z.string().min(1).max(256));

const isoTimestampSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});

const tagsSchema = z.array(rawTokenSchema).max(8).superRefine((tags, context) => {
  if (new Set(tags).size !== tags.length) {
    context.addIssue({ code: "custom", message: "Duplicate public tag" });
  }
});

const reportFieldsBaseSchema = z.strictObject({
  category: rawTokenSchema,
  timeWindow: z.strictObject({ from: isoTimestampSchema, to: isoTimestampSchema }),
  area: rawTokenSchema,
  color: rawTokenSchema,
  publicTags: tagsSchema,
  publicDescription: descriptionSchema,
});

const reportFieldsSchema = reportFieldsBaseSchema.superRefine((value, context) => {
  if (Date.parse(value.timeWindow.from) > Date.parse(value.timeWindow.to)) {
    context.addIssue({ code: "custom", path: ["timeWindow"], message: "Reverse time window" });
  }
});

const createFormSchema = z.strictObject({
  category: z.string(),
  timeFrom: z.string(),
  timeTo: z.string(),
  area: z.string(),
  color: z.string(),
  publicTags: z.string().max(1_024),
  publicDescription: z.string(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
});

const updateFormSchema = z.strictObject({
  expectedVersion: z.string().regex(CANONICAL_INTEGER),
  category: z.string().optional(),
  timeFrom: z.string().optional(),
  timeTo: z.string().optional(),
  area: z.string().optional(),
  color: z.string().optional(),
  publicTags: z.string().max(1_024).optional(),
  publicDescription: z.string().optional(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
});

const reportPatchSchema = z.strictObject({
  category: rawTokenSchema.optional(),
  timeWindow: z.strictObject({ from: isoTimestampSchema, to: isoTimestampSchema }).optional(),
  area: rawTokenSchema.optional(),
  color: rawTokenSchema.optional(),
  publicTags: tagsSchema.optional(),
  publicDescription: descriptionSchema.optional(),
}).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({ code: "custom", message: "Empty report patch" });
  }
  if (value.timeWindow && Date.parse(value.timeWindow.from) > Date.parse(value.timeWindow.to)) {
    context.addIssue({ code: "custom", path: ["timeWindow"], message: "Reverse time window" });
  }
});

const createCommandSchema = z.strictObject({
  ...reportFieldsBaseSchema.shape,
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
}).superRefine((value, context) => {
  if (Date.parse(value.timeWindow.from) > Date.parse(value.timeWindow.to)) {
    context.addIssue({ code: "custom", path: ["timeWindow"], message: "Reverse time window" });
  }
});

const updateCommandSchema = z.strictObject({
  expectedVersion: z.number().int().safe().positive(),
  patch: reportPatchSchema,
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
});

export type CreateReportCommand = LostReport & { idempotencyKey: string };
export type UpdateReportCommand = {
  expectedVersion: number;
  patch: Partial<LostReport>;
  idempotencyKey: string;
};

function formRecord(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  if (entries.some(([key, value]) => typeof key !== "string" || typeof value !== "string")) {
    throw new DomainError("VALIDATION_FAILED");
  }
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) throw new DomainError("VALIDATION_FAILED");
  return Object.fromEntries(entries);
}

function parseTags(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DomainError("VALIDATION_FAILED");
  }
}

function validationFailure(): never {
  throw new DomainError("VALIDATION_FAILED");
}

export function parseCreateReportForm(
  entries: ReadonlyArray<readonly [string, string]>,
): CreateReportCommand {
  const raw = createFormSchema.safeParse(formRecord(entries));
  if (!raw.success) return validationFailure();
  const business = reportFieldsSchema.safeParse({
    category: raw.data.category,
    timeWindow: { from: raw.data.timeFrom, to: raw.data.timeTo },
    area: raw.data.area,
    color: raw.data.color,
    publicTags: parseTags(raw.data.publicTags),
    publicDescription: raw.data.publicDescription,
  });
  if (!business.success) return validationFailure();
  return { ...business.data, idempotencyKey: raw.data.idempotencyKey };
}

export function parseUpdateReportForm(
  entries: ReadonlyArray<readonly [string, string]>,
): UpdateReportCommand {
  const raw = updateFormSchema.safeParse(formRecord(entries));
  if (!raw.success) return validationFailure();
  const expectedVersion = Number(raw.data.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion)) return validationFailure();
  const hasFrom = raw.data.timeFrom !== undefined;
  const hasTo = raw.data.timeTo !== undefined;
  if (hasFrom !== hasTo) return validationFailure();
  const patchInput: Record<string, unknown> = {};
  for (const field of ["category", "area", "color", "publicDescription"] as const) {
    if (raw.data[field] !== undefined) patchInput[field] = raw.data[field];
  }
  if (raw.data.publicTags !== undefined) patchInput.publicTags = parseTags(raw.data.publicTags);
  if (hasFrom && hasTo) patchInput.timeWindow = { from: raw.data.timeFrom, to: raw.data.timeTo };
  if (Object.keys(patchInput).length === 0) return validationFailure();
  const patch = reportPatchSchema.safeParse(patchInput);
  if (!patch.success) return validationFailure();
  if (
    patch.data.timeWindow
    && Date.parse(patch.data.timeWindow.from) > Date.parse(patch.data.timeWindow.to)
  ) return validationFailure();
  return { expectedVersion, patch: patch.data, idempotencyKey: raw.data.idempotencyKey };
}

export function validateCreateReportCommand(value: unknown): CreateReportCommand {
  const parsed = createCommandSchema.safeParse(value);
  if (!parsed.success) return validationFailure();
  return parsed.data;
}

export function validateUpdateReportCommand(value: unknown): UpdateReportCommand {
  const parsed = updateCommandSchema.safeParse(value);
  if (!parsed.success) return validationFailure();
  return parsed.data;
}

export function parseExpectedVersionForm(
  entries: ReadonlyArray<readonly [string, string]>,
): { csrfToken: string; expectedVersion: number } {
  const schema = z.strictObject({
    csrfToken: z.string().min(1).max(1_024),
    expectedVersion: z.string().regex(CANONICAL_INTEGER),
  });
  const parsed = schema.safeParse(formRecord(entries));
  if (!parsed.success) return validationFailure();
  const expectedVersion = Number(parsed.data.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion)) return validationFailure();
  return { csrfToken: parsed.data.csrfToken, expectedVersion };
}
