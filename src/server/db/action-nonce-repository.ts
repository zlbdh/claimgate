import { RATE_LIMIT_ACTIONS, type RateLimitAction } from "@/server/security/rate-limit";
import { decodeCanonicalBase64Url32 } from "@/shared/canonical-base64url";
import { DomainError } from "@/shared/domain-error";
import { activeInstance, immediate } from "./repository-internal";
import type { ConsumeActionNonceInput, RepositoryContext } from "./repository-types";

export function consumeActionNonce(
  context: RepositoryContext,
  input: ConsumeActionNonceInput,
): void {
  const nonceDigest = decodeCanonicalBase64Url32(input.nonceDigest);
  if (
    !RATE_LIMIT_ACTIONS.includes(input.action as RateLimitAction)
    || !nonceDigest
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
    `).run(input.demoInstanceId, nonceDigest, input.action, consumedAtMs);
    if (result.changes !== 1) throw new DomainError("FORBIDDEN");
  });
}
