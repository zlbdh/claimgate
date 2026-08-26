import { createHash } from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import type { IdempotencyRequest, IdempotencyResult, RepositoryContext } from "./repository-types";
import {
  activeInstance,
  assertNoInternalInventoryIdentity,
  immediate,
  rejectAsyncCallback,
  rejectPromise,
  requireActor,
  requireText,
} from "./repository-internal";

type IdempotencyRow = {
  requestFingerprintDigest: Buffer;
  resultJson: string;
};

function digest(domain: string, value: string): Buffer {
  requireText(value);
  return createHash("sha256").update(domain, "utf8").update("\0", "utf8").update(value, "utf8").digest();
}

const IDEMPOTENCY_ACTIONS = ["draft_create", "draft_update", "claim_stage"] as const;

function validateResult(
  request: IdempotencyRequest,
  value: unknown,
  errorCode: "VALIDATION_FAILED" | "CONFIGURATION_ERROR",
): IdempotencyResult {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new DomainError(errorCode);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !("value" in descriptors[key]))) {
    throw new DomainError(errorCode);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "report_ack") {
    if (
      !["draft_create", "draft_update"].includes(request.action)
      || keys.length !== 4
      || !["kind", "reportId", "status", "version"].every((key) => keys.includes(key))
      || typeof record.reportId !== "string"
      || record.status !== "DRAFT"
      || !Number.isSafeInteger(record.version)
      || Number(record.version) < 1
    ) {
      throw new DomainError(errorCode);
    }
  } else if (record.kind === "claim_ack") {
    if (
      request.action !== "claim_stage"
      || keys.length !== 4
      || !["kind", "claimId", "status", "version"].every((key) => keys.includes(key))
      || typeof record.claimId !== "string"
      || record.status !== "EVIDENCE_REQUIRED"
      || !Number.isSafeInteger(record.version)
      || Number(record.version) < 1
    ) {
      throw new DomainError(errorCode);
    }
  } else {
    throw new DomainError(errorCode);
  }
  return value as IdempotencyResult;
}

function canonicalResult(
  context: RepositoryContext,
  request: IdempotencyRequest,
  value: unknown,
  errorCode: "VALIDATION_FAILED" | "CONFIGURATION_ERROR",
): { result: IdempotencyResult; resultJson: string } {
  const validated = validateResult(request, value, errorCode);
  const canonical = Object.create(null) as Record<string, unknown>;
  if (validated.kind === "report_ack") {
    canonical.kind = "report_ack";
    canonical.reportId = validated.reportId;
    canonical.status = "DRAFT";
    canonical.version = validated.version;
  } else {
    canonical.kind = "claim_ack";
    canonical.claimId = validated.claimId;
    canonical.status = "EVIDENCE_REQUIRED";
    canonical.version = validated.version;
  }
  const resultJson = JSON.stringify(canonical);
  if (resultJson.length > 1_024) throw new DomainError(errorCode);
  const parsed = validateResult(request, JSON.parse(resultJson) as unknown, errorCode);
  assertNoInternalInventoryIdentity(
    context,
    parsed,
    errorCode,
  );
  const result: Record<string, unknown> = {};
  if (parsed.kind === "report_ack") {
    result.kind = "report_ack";
    result.reportId = parsed.reportId;
    result.status = "DRAFT";
    result.version = parsed.version;
  } else {
    result.kind = "claim_ack";
    result.claimId = parsed.claimId;
    result.status = "EVIDENCE_REQUIRED";
    result.version = parsed.version;
  }
  Object.defineProperty(result, "toJSON", {
    configurable: false,
    enumerable: false,
    value: undefined,
    writable: false,
  });
  return { result: result as IdempotencyResult, resultJson };
}

export function runIdempotent(
  context: RepositoryContext,
  request: IdempotencyRequest,
  mutation: () => IdempotencyResult,
): IdempotencyResult {
  rejectAsyncCallback(mutation);
  return immediate(context, () => {
    activeInstance(context, request.demoInstanceId);
    requireActor(request.actorId);
    if (!IDEMPOTENCY_ACTIONS.includes(request.action)) {
      throw new DomainError("VALIDATION_FAILED");
    }
    assertNoInternalInventoryIdentity(context, request, "VALIDATION_FAILED");
    const keyDigest = digest("ClaimGate/idempotency-key/v1", request.idempotencyKey);
    const fingerprintDigest = digest(
      "ClaimGate/request-fingerprint/v1",
      request.requestFingerprint,
    );
    const existing = context.database.prepare(`
      SELECT request_fingerprint_digest AS requestFingerprintDigest, result_json AS resultJson
      FROM idempotency_records
      WHERE demo_instance_id = ? AND actor_id = ? AND action = ? AND key_digest = ?
    `).get(
      request.demoInstanceId,
      request.actorId,
      request.action,
      keyDigest,
    ) as IdempotencyRow | undefined;
    if (existing) {
      if (!existing.requestFingerprintDigest.equals(fingerprintDigest)) {
        throw new DomainError("CONFLICT");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing.resultJson) as unknown;
      } catch {
        throw new DomainError("CONFIGURATION_ERROR");
      }
      const canonical = canonicalResult(context, request, parsed, "CONFIGURATION_ERROR");
      if (canonical.resultJson !== existing.resultJson) {
        throw new DomainError("CONFIGURATION_ERROR");
      }
      return canonical.result;
    }

    const result = mutation();
    rejectPromise(result);
    const canonical = canonicalResult(context, request, result, "VALIDATION_FAILED");
    context.database.prepare(`
      INSERT INTO idempotency_records (
        demo_instance_id, actor_id, action, key_digest,
        request_fingerprint_digest, result_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.demoInstanceId,
      request.actorId,
      request.action,
      keyDigest,
      fingerprintDigest,
      canonical.resultJson,
      context.now(),
    );
    return canonical.result;
  });
}
