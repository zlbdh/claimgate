import { createHash } from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import type { IdempotencyRequest, IdempotencyResult, RepositoryContext } from "./repository-types";
import {
  activeInstance,
  assertNoInternalInventoryId,
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

function canonicalResultJson(
  context: RepositoryContext,
  request: IdempotencyRequest,
  value: unknown,
): string {
  const validated = validateResult(request, value, "VALIDATION_FAILED");
  assertNoInternalInventoryId(
    context,
    request.demoInstanceId,
    validated,
    "VALIDATION_FAILED",
  );
  const resultJson = JSON.stringify(validated);
  if (resultJson.length > 1_024) throw new DomainError("VALIDATION_FAILED");
  return resultJson;
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
    assertNoInternalInventoryId(context, request.demoInstanceId, request, "VALIDATION_FAILED");
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
      const validated = validateResult(request, parsed, "CONFIGURATION_ERROR");
      assertNoInternalInventoryId(
        context,
        request.demoInstanceId,
        validated,
        "CONFIGURATION_ERROR",
      );
      return validated;
    }

    const result = mutation();
    rejectPromise(result);
    const resultJson = canonicalResultJson(context, request, result);
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
      resultJson,
      context.now(),
    );
    return JSON.parse(resultJson) as IdempotencyResult;
  });
}
