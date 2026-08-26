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

export const RATE_LIMIT_ACTIONS = Object.freeze([
  "demo_start", "role_switch", "draft_create", "draft_update", "report_publish",
  "report_archive", "claim_stage", "evidence_submit", "claim_approve", "claim_reject",
  "claim_unlock", "pickup_issue", "pickup_reissue", "handoff", "match_find",
] as const);

export type PersistentRateLimiter = {
  consume(input: RateLimitInput): RateLimitResult;
};

function validInteger(value: number, positive = false): boolean {
  return Number.isSafeInteger(value) && (!positive || value > 0);
}

export function createPersistentRateLimiter(options: {
  database: Database.Database;
  now?: () => number;
}): PersistentRateLimiter {
  const now = options.now ?? Date.now;
  const consumeInTransaction = options.database.transaction((input: RateLimitInput) => {
    const currentTime = now();
    if (
      !validInteger(currentTime) || currentTime < 0 ||
      !validInteger(input.limit, true) ||
      !validInteger(input.windowMs, true) ||
      input.limit > 1_000 ||
      input.windowMs > 86_400_000 ||
      typeof input.demoInstanceId !== "string" || !input.demoInstanceId ||
      !["claimant-demo", "staff-demo"].includes(input.actorId) ||
      !RATE_LIMIT_ACTIONS.includes(input.action as (typeof RATE_LIMIT_ACTIONS)[number])
    ) {
      throw new DomainError("VALIDATION_FAILED");
    }
    const highWater = options.database.prepare(`
      SELECT high_water_time_ms AS highWaterTimeMs, limit_value AS limitValue,
        window_ms AS windowMs
      FROM rate_limit_high_water
      WHERE demo_instance_id = ? AND actor_id = ? AND action = ?
    `).get(input.demoInstanceId, input.actorId, input.action) as {
      highWaterTimeMs: number;
      limitValue: number;
      windowMs: number;
    } | undefined;
    if (highWater && (highWater.limitValue !== input.limit || highWater.windowMs !== input.windowMs)) {
      throw new DomainError("VALIDATION_FAILED");
    }
    const effectiveTime = Math.max(currentTime, highWater?.highWaterTimeMs ?? currentTime);
    const active = options.database.prepare(`
      SELECT 1 FROM demo_instances WHERE id = ? AND expires_at_ms > ?
    `).get(input.demoInstanceId, effectiveTime);
    if (!active) throw new DomainError("NOT_FOUND");
    options.database.prepare(`
      INSERT INTO rate_limit_high_water (
        demo_instance_id, actor_id, action, high_water_time_ms, limit_value, window_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (demo_instance_id, actor_id, action)
      DO UPDATE SET high_water_time_ms = MAX(high_water_time_ms, excluded.high_water_time_ms)
    `).run(
      input.demoInstanceId,
      input.actorId,
      input.action,
      effectiveTime,
      input.limit,
      input.windowMs,
    );
    const windowStartMs = Math.floor(effectiveTime / input.windowMs) * input.windowMs;
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
      retryAfterMs: Math.max(1, windowStartMs + input.windowMs - effectiveTime),
    };
  });

  return { consume: (input) => consumeInTransaction.immediate(input) };
}
