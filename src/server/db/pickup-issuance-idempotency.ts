import { createHash } from "node:crypto";
import { parsePickupPassToken } from "@/features/claims/pickup-pass-crypto";
import { DomainError } from "@/shared/domain-error";
import {
  activeInstance,
  assertNoInternalInventoryIdentity,
  immediate,
  rejectAsyncCallback,
  rejectPromise,
  requireActor,
  requireText,
} from "./repository-internal";
import type {
  PickupIssuanceIdempotencyRequest,
  PickupIssuanceMutation,
  PickupIssuanceResult,
  PickupPassAck,
  RepositoryContext,
} from "./repository-types";

type StoredRow = { requestFingerprintDigest: Buffer; resultJson: string };

function digest(domain: string, value: string): Buffer {
  requireText(value);
  return createHash("sha256").update(domain).update("\0").update(value).digest();
}

function fields(
  value: unknown,
  errorCode: "VALIDATION_FAILED" | "CONFIGURATION_ERROR",
): Map<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new DomainError(errorCode);
  }
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new DomainError(errorCode);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new DomainError(errorCode);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function canonicalAck(
  context: RepositoryContext,
  request: PickupIssuanceIdempotencyRequest,
  value: unknown,
  stored: boolean,
): { ack: PickupPassAck; json: string } {
  try {
    const source = fields(value, stored ? "CONFIGURATION_ERROR" : "VALIDATION_FAILED");
    const keys = ["kind", "claimId", "status", "claimVersion", "generation", "expiresAtMs"];
    if (
      source.size !== keys.length
      || keys.some((key) => !source.has(key))
      || source.get("kind") !== "pickup_pass_ack"
      || source.get("claimId") !== request.expectedClaimId
      || source.get("status") !== "PICKUP_READY"
      || !Number.isSafeInteger(source.get("claimVersion"))
      || Number(source.get("claimVersion")) < 1
      || !Number.isSafeInteger(source.get("generation"))
      || Number(source.get("generation")) < 1
      || !Number.isSafeInteger(source.get("expiresAtMs"))
      || Number(source.get("expiresAtMs")) < 1
    ) throw new Error();
    const ack = {
      kind: "pickup_pass_ack" as const,
      claimId: source.get("claimId") as string,
      status: "PICKUP_READY" as const,
      claimVersion: source.get("claimVersion") as number,
      generation: source.get("generation") as number,
      expiresAtMs: source.get("expiresAtMs") as number,
    };
    const json = JSON.stringify(ack);
    if (json.length > 512) throw new Error();
    assertNoInternalInventoryIdentity(context, ack, stored ? "CONFIGURATION_ERROR" : "VALIDATION_FAILED");
    return { ack: Object.freeze(ack), json };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(stored ? "CONFIGURATION_ERROR" : "VALIDATION_FAILED");
  }
}

export function runPickupIssuanceIdempotent(
  context: RepositoryContext,
  request: PickupIssuanceIdempotencyRequest,
  mutation: () => PickupIssuanceMutation,
): PickupIssuanceResult {
  rejectAsyncCallback(mutation);
  return immediate(context, () => {
    activeInstance(context, request.demoInstanceId);
    if (
      requireActor(request.actorId) !== "claimant-demo"
      || !["pickup_issue", "pickup_reissue"].includes(request.action)
      || typeof request.expectedClaimId !== "string"
    ) throw new DomainError("VALIDATION_FAILED");
    requireText(request.expectedClaimId);
    assertNoInternalInventoryIdentity(context, request, "VALIDATION_FAILED");
    const keyDigest = digest("ClaimGate/idempotency-key/v1", request.idempotencyKey);
    const fingerprintDigest = digest("ClaimGate/request-fingerprint/v1", request.requestFingerprint);
    const existing = context.database.prepare(`
      SELECT request_fingerprint_digest AS requestFingerprintDigest, result_json AS resultJson
      FROM idempotency_records
      WHERE demo_instance_id = ? AND actor_id = ? AND action = ? AND key_digest = ?
    `).get(request.demoInstanceId, request.actorId, request.action, keyDigest) as StoredRow | undefined;
    if (existing) {
      if (!existing.requestFingerprintDigest.equals(fingerprintDigest)) throw new DomainError("CONFLICT");
      let parsed: unknown;
      try { parsed = JSON.parse(existing.resultJson) as unknown; } catch {
        throw new DomainError("CONFIGURATION_ERROR");
      }
      const stored = canonicalAck(context, request, parsed, true);
      if (stored.json !== existing.resultJson) throw new DomainError("CONFIGURATION_ERROR");
      return Object.freeze({ issuance: "ALREADY_ISSUED", ack: stored.ack });
    }

    const produced = mutation();
    rejectPromise(produced);
    const producedFields = fields(produced, "VALIDATION_FAILED");
    if (
      producedFields.size !== 2
      || !producedFields.has("safeAck")
      || !producedFields.has("transientToken")
    ) throw new DomainError("VALIDATION_FAILED");
    const transientToken = producedFields.get("transientToken");
    parsePickupPassToken(transientToken);
    const safe = canonicalAck(context, request, producedFields.get("safeAck"), false);
    const inserted = context.database.prepare(`
      INSERT INTO idempotency_records (
        demo_instance_id, actor_id, action, key_digest,
        request_fingerprint_digest, result_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.demoInstanceId, request.actorId, request.action, keyDigest,
      fingerprintDigest, safe.json, context.now(),
    );
    if (inserted.changes !== 1) throw new DomainError("CONFIGURATION_ERROR");
    return Object.freeze({
      issuance: "ISSUED",
      ack: safe.ack,
      transientToken: transientToken as string,
    });
  });
}
