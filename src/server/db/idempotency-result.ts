import { DomainError } from "@/shared/domain-error";
import type {
  IdempotencyRequest,
  IdempotencyResult,
  RepositoryContext,
} from "./repository-types";
import { assertNoInternalInventoryIdentity } from "./repository-internal";

type ErrorCode = "VALIDATION_FAILED" | "CONFIGURATION_ERROR";

function readFields(value: unknown, errorCode: ErrorCode): Map<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new DomainError(errorCode);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new DomainError(errorCode);
    const holder = Object.getOwnPropertyDescriptor(descriptors, key);
    if (!holder || !Object.hasOwn(holder, "value")) throw new DomainError(errorCode);
    const descriptor = holder.value as PropertyDescriptor;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new DomainError(errorCode);
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function exactFields(fields: Map<string, unknown>, keys: readonly string[]): boolean {
  return fields.size === keys.length && keys.every((key) => fields.has(key));
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function dataRecord(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return result;
}

function validateClaimState(
  request: IdempotencyRequest,
  fields: Map<string, unknown>,
  errorCode: ErrorCode,
): IdempotencyResult {
  const keys = [
    "kind", "claimId", "status", "version", "failedAttempts",
    "evidenceEligible", "unlockCount", "rejectionReason",
  ];
  const result = dataRecord(fields);
  const common = exactFields(fields, keys)
    && result.kind === "claim_state_ack"
    && typeof result.claimId === "string"
    && typeof result.status === "string"
    && positiveVersion(result.version)
    && Number.isSafeInteger(result.failedAttempts)
    && Number(result.failedAttempts) >= 0
    && Number(result.failedAttempts) <= 3
    && typeof result.evidenceEligible === "boolean"
    && Number.isSafeInteger(result.unlockCount)
    && Number(result.unlockCount) >= 0
    && Number(result.unlockCount) <= 1;
  if (!common) throw new DomainError(errorCode);
  const attempts = result.failedAttempts as number;
  const unlock = result.unlockCount as number;
  const actionBound = request.action === "evidence_submit"
    ? (
        (result.status === "EVIDENCE_REQUIRED" && attempts >= 1 && attempts <= 2
          && result.evidenceEligible === false)
        || (result.status === "UNDER_REVIEW" && attempts >= 0 && attempts <= 2
          && result.evidenceEligible === true)
        || (result.status === "LOCKED" && attempts === 3 && result.evidenceEligible === false)
      ) && result.rejectionReason === null && unlock >= 0 && unlock <= 1
    : request.action === "claim_approve"
      ? result.status === "APPROVED" && attempts >= 0 && attempts <= 2
        && result.evidenceEligible === true && result.rejectionReason === null
        && unlock >= 0 && unlock <= 1
      : request.action === "claim_reject"
        ? result.status === "REJECTED" && attempts >= 0 && attempts <= 2
          && result.evidenceEligible === true && result.rejectionReason === "STAFF_REJECTED"
          && unlock >= 0 && unlock <= 1
        : request.action === "claim_unlock"
          ? result.status === "EVIDENCE_REQUIRED" && attempts === 0
            && result.evidenceEligible === false && unlock === 1 && result.rejectionReason === null
          : false;
  const actorBound = request.action === "evidence_submit"
    ? request.actorId === "claimant-demo"
    : request.actorId === "staff-demo";
  if (
    !actionBound
    || !actorBound
    || typeof request.expectedClaimId !== "string"
    || request.expectedClaimId !== result.claimId
  ) throw new DomainError(errorCode);
  return result as IdempotencyResult;
}

function validateResult(
  request: IdempotencyRequest,
  value: unknown,
  errorCode: ErrorCode,
): IdempotencyResult {
  const fields = readFields(value, errorCode);
  const kind = fields.get("kind");
  if (kind === "report_ack") {
    if (
      !["draft_create", "draft_update"].includes(request.action)
      || request.actorId !== "claimant-demo"
      || !exactFields(fields, ["kind", "reportId", "status", "version"])
      || typeof fields.get("reportId") !== "string"
      || fields.get("status") !== "DRAFT"
      || !positiveVersion(fields.get("version"))
    ) throw new DomainError(errorCode);
    return dataRecord(fields) as IdempotencyResult;
  }
  if (kind === "claim_ack") {
    if (
      request.action !== "claim_stage"
      || request.actorId !== "claimant-demo"
      || !exactFields(fields, ["kind", "claimId", "status", "version"])
      || typeof fields.get("claimId") !== "string"
      || fields.get("status") !== "EVIDENCE_REQUIRED"
      || !positiveVersion(fields.get("version"))
    ) throw new DomainError(errorCode);
    return dataRecord(fields) as IdempotencyResult;
  }
  if (kind === "claim_state_ack") return validateClaimState(request, fields, errorCode);
  if (kind === "handoff_ack") {
    const keys = [
      "kind", "claimId", "completion", "claimStatus", "claimVersion",
      "itemStatus", "itemVersion", "reportStatus", "reportVersion", "generation",
    ];
    if (
      request.action !== "handoff"
      || request.actorId !== "staff-demo"
      || request.expectedClaimId !== fields.get("claimId")
      || !exactFields(fields, keys)
      || !["COLLECTED", "ALREADY_COLLECTED"].includes(String(fields.get("completion")))
      || fields.get("claimStatus") !== "COLLECTED"
      || fields.get("itemStatus") !== "RETURNED"
      || fields.get("reportStatus") !== "RESOLVED"
      || !positiveVersion(fields.get("claimVersion"))
      || !positiveVersion(fields.get("itemVersion"))
      || !positiveVersion(fields.get("reportVersion"))
      || !positiveVersion(fields.get("generation"))
    ) throw new DomainError(errorCode);
    return dataRecord(fields) as IdempotencyResult;
  }
  throw new DomainError(errorCode);
}

function canonicalRecord(value: IdempotencyResult): Record<string, unknown> {
  if (value.kind === "report_ack") return dataRecord([
    ["kind", value.kind], ["reportId", value.reportId],
    ["status", value.status], ["version", value.version],
  ]);
  if (value.kind === "claim_ack") return dataRecord([
    ["kind", value.kind], ["claimId", value.claimId],
    ["status", value.status], ["version", value.version],
  ]);
  if (value.kind === "handoff_ack") return dataRecord([
    ["kind", value.kind], ["claimId", value.claimId], ["completion", value.completion],
    ["claimStatus", value.claimStatus], ["claimVersion", value.claimVersion],
    ["itemStatus", value.itemStatus], ["itemVersion", value.itemVersion],
    ["reportStatus", value.reportStatus], ["reportVersion", value.reportVersion],
    ["generation", value.generation],
  ]);
  return dataRecord([
    ["kind", value.kind],
    ["claimId", value.claimId],
    ["status", value.status],
    ["version", value.version],
    ["failedAttempts", value.failedAttempts],
    ["evidenceEligible", value.evidenceEligible],
    ["unlockCount", value.unlockCount],
    ["rejectionReason", value.rejectionReason],
  ]);
}

function publicResult(record: Record<string, unknown>): IdempotencyResult {
  const descriptors = Object.create(null) as PropertyDescriptorMap;
  for (const [key, value] of Object.entries(record)) {
    descriptors[key] = { configurable: true, enumerable: true, value, writable: true };
  }
  descriptors.toJSON = { configurable: false, enumerable: false, value: undefined, writable: false };
  return Object.defineProperties({}, descriptors) as IdempotencyResult;
}

export function canonicalizeIdempotencyResult(
  context: RepositoryContext,
  request: IdempotencyRequest,
  value: unknown,
  errorCode: ErrorCode,
): { result: IdempotencyResult; resultJson: string } {
  const validated = validateResult(request, value, errorCode);
  const canonical = canonicalRecord(validated);
  const resultJson = JSON.stringify(canonical);
  if (resultJson.length > 1_024) throw new DomainError(errorCode);
  const parsed = validateResult(request, JSON.parse(resultJson) as unknown, errorCode);
  assertNoInternalInventoryIdentity(context, parsed, errorCode);
  return { result: publicResult(canonicalRecord(parsed)), resultJson };
}
