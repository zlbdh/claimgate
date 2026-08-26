import type Database from "better-sqlite3";
import { DomainError } from "@/shared/domain-error";

export type RateLimitInput = {
  demoInstanceId: string;
  actorId: string;
  action: string;
  limit: number;
  windowMs: number;
};

export type RateLimitResult = { allowed: boolean; retryAfterMs: number };

export type PersistentRateLimiter = {
  consume(input: RateLimitInput): RateLimitResult;
};

function validInteger(value: number, positive = false): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && (!positive || value > 0);
}

export function createPersistentRateLimiter(options: {
  database: Database.Database;
  now?: () => number;
}): PersistentRateLimiter {
  const now = options.now ?? Date.now;
  const consumeInTransaction = options.database.transaction((input: RateLimitInput) => {
    const currentTime = now();
    if (
      !validInteger(currentTime) ||
      !validInteger(input.limit, true) ||
      !validInteger(input.windowMs, true) ||
      !input.demoInstanceId ||
      !input.actorId ||
      !input.action
    ) {
      throw new DomainError("VALIDATION_FAILED");
    }
    const active = options.database.prepare(`
      SELECT 1 FROM demo_instances WHERE id = ? AND expires_at_ms > ?
    `).get(input.demoInstanceId, currentTime);
    if (!active) throw new DomainError("NOT_FOUND");
    const windowStartMs = Math.floor(currentTime / input.windowMs) * input.windowMs;
    const result = options.database.prepare(`
      INSERT INTO rate_limit_buckets (
        demo_instance_id, actor_id, action, window_start_ms, request_count
      ) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (demo_instance_id, actor_id, action, window_start_ms)
      DO UPDATE SET request_count = request_count + 1
      WHERE request_count < ?
    `).run(
      input.demoInstanceId,
      input.actorId,
      input.action,
      windowStartMs,
      input.limit,
    );
    if (result.changes === 1) return { allowed: true, retryAfterMs: 0 };
    return {
      allowed: false,
      retryAfterMs: Math.max(1, windowStartMs + input.windowMs - currentTime),
    };
  });

  return { consume: (input) => consumeInTransaction.immediate(input) };
}
