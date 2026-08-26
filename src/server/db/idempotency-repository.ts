import { createHash } from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import type { IdempotencyRequest, RepositoryContext } from "./repository-types";
import {
  activeInstance,
  immediate,
  rejectAsyncCallback,
  rejectPromise,
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

function boundedResultJson(value: unknown): string {
  const resultJson = JSON.stringify(value);
  if (!resultJson || resultJson.length > 4_096) throw new DomainError("VALIDATION_FAILED");
  const parsed = JSON.parse(resultJson) as unknown;
  const forbidden = /evidence|pickup|cookie|session|secret|token|(?:inventory|found)[_-]?item[_-]?id/i;
  const inspect = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (forbidden.test(key)) throw new DomainError("VALIDATION_FAILED");
      inspect(child);
    }
  };
  inspect(parsed);
  return resultJson;
}

export function runIdempotent<T>(
  context: RepositoryContext,
  request: IdempotencyRequest,
  mutation: () => T,
): T {
  rejectAsyncCallback(mutation);
  return immediate(context, () => {
    activeInstance(context, request.demoInstanceId);
    requireText(request.actorId);
    requireText(request.action);
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
      return JSON.parse(existing.resultJson) as T;
    }

    const result = mutation();
    rejectPromise(result);
    const resultJson = boundedResultJson(result);
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
    return result;
  });
}
