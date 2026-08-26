import type Database from "better-sqlite3";
import { DomainError } from "@/shared/domain-error";
import type { RateLimitResult } from "./rate-limit";

export const APP_GLOBAL_RATE_LIMIT = Object.freeze({
  scope: "public-demo-entry",
  action: "demo_start",
  limit: 30,
  windowMs: 60_000,
} as const);

export type GlobalRateLimitInput = {
  scope: string;
  action: string;
  limit: number;
  windowMs: number;
};

function validInteger(value: number, positive = false): boolean {
  return Number.isSafeInteger(value) && (!positive || value > 0);
}

export function createPersistentGlobalRateLimiter(options: {
  database: Database.Database;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const consume = (input: GlobalRateLimitInput): RateLimitResult => {
    const currentTime = now();
    if (
      input.scope !== APP_GLOBAL_RATE_LIMIT.scope
      || input.action !== APP_GLOBAL_RATE_LIMIT.action
      || input.limit !== APP_GLOBAL_RATE_LIMIT.limit
      || input.windowMs !== APP_GLOBAL_RATE_LIMIT.windowMs
      || !validInteger(input.limit, true) || input.limit > 1_000
      || !validInteger(input.windowMs, true) || input.windowMs > 86_400_000
      || !validInteger(currentTime) || currentTime < 0
    ) throw new DomainError("VALIDATION_FAILED");
    const highWater = options.database.prepare(`
      SELECT high_water_time_ms AS highWaterTimeMs, limit_value AS limitValue,
        window_ms AS windowMs
      FROM application_rate_limit_high_water WHERE scope = ? AND action = ?
    `).get(input.scope, input.action) as {
      highWaterTimeMs: number; limitValue: number; windowMs: number;
    } | undefined;
    if (highWater && (highWater.limitValue !== input.limit || highWater.windowMs !== input.windowMs)) {
      throw new DomainError("VALIDATION_FAILED");
    }
    const effectiveTime = Math.max(currentTime, highWater?.highWaterTimeMs ?? currentTime);
    options.database.prepare(`
      INSERT INTO application_rate_limit_high_water (
        scope, action, high_water_time_ms, limit_value, window_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (scope, action) DO UPDATE SET
        high_water_time_ms = MAX(high_water_time_ms, excluded.high_water_time_ms)
    `).run(input.scope, input.action, effectiveTime, input.limit, input.windowMs);
    const windowStartMs = Math.floor(effectiveTime / input.windowMs) * input.windowMs;
    const result = options.database.prepare(`
      INSERT INTO application_rate_limit_buckets (
        scope, action, window_start_ms, request_count
      ) VALUES (?, ?, ?, 1)
      ON CONFLICT (scope, action, window_start_ms)
      DO UPDATE SET request_count = request_count + 1 WHERE request_count < ?
    `).run(input.scope, input.action, windowStartMs, input.limit);
    if (result.changes === 1) return { allowed: true, retryAfterMs: 0 };
    return {
      allowed: false,
      retryAfterMs: Math.max(1, windowStartMs + input.windowMs - effectiveTime),
    };
  };
  const transaction = options.database.transaction(consume);
  return Object.freeze({
    consume(input: GlobalRateLimitInput) {
      return options.database.inTransaction ? consume(input) : transaction.immediate(input);
    },
  });
}

export type PersistentGlobalRateLimiter = ReturnType<typeof createPersistentGlobalRateLimiter>;
