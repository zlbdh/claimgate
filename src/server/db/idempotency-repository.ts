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
import { canonicalizeIdempotencyResult } from "./idempotency-result";

type IdempotencyRow = {
  requestFingerprintDigest: Buffer;
  resultJson: string;
};

function digest(domain: string, value: string): Buffer {
  requireText(value);
  return createHash("sha256").update(domain, "utf8").update("\0", "utf8").update(value, "utf8").digest();
}

const IDEMPOTENCY_ACTIONS = [
  "draft_create", "draft_update", "claim_stage",
  "evidence_submit", "claim_approve", "claim_reject", "claim_unlock",
  "handoff",
] as const;

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
      const canonical = canonicalizeIdempotencyResult(context, request, parsed, "CONFIGURATION_ERROR");
      if (canonical.resultJson !== existing.resultJson) {
        throw new DomainError("CONFIGURATION_ERROR");
      }
      return canonical.result;
    }

    const result = mutation();
    rejectPromise(result);
    const canonical = canonicalizeIdempotencyResult(context, request, result, "VALIDATION_FAILED");
    const inserted = context.database.prepare(`
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
    if (inserted.changes !== 1) throw new DomainError("CONFIGURATION_ERROR");
    return canonical.result;
  });
}
