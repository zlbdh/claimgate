import { Buffer } from "node:buffer";
import { RATE_LIMIT_ACTIONS, type RateLimitAction } from "@/server/security/rate-limit";
import { DomainError } from "@/shared/domain-error";
import { activeInstance, immediate } from "./repository-internal";
import type { ConsumeActionNonceInput, RepositoryContext } from "./repository-types";

export function consumeActionNonce(
  context: RepositoryContext,
  input: ConsumeActionNonceInput,
): void {
  if (
    !RATE_LIMIT_ACTIONS.includes(input.action as RateLimitAction)
    || !Buffer.isBuffer(input.nonceDigest)
    || input.nonceDigest.length !== 32
  ) throw new DomainError("VALIDATION_FAILED");
  const consumedAtMs = context.now();
  if (!Number.isSafeInteger(consumedAtMs) || consumedAtMs < 0) {
    throw new DomainError("VALIDATION_FAILED");
  }
  immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const result = context.database.prepare(`
      INSERT OR IGNORE INTO consumed_action_nonces (
        demo_instance_id, nonce_digest, action, consumed_at_ms
      ) VALUES (?, ?, ?, ?)
    `).run(input.demoInstanceId, Buffer.from(input.nonceDigest), input.action, consumedAtMs);
    if (result.changes !== 1) throw new DomainError("FORBIDDEN");
  });
}
