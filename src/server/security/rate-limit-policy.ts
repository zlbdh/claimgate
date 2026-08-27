import { RATE_LIMIT_ACTIONS, type RateLimitAction } from "./rate-limit";

export type RateLimitPolicy = Readonly<{ limit: number; windowMs: number }>;

const policies: Record<RateLimitAction, RateLimitPolicy> = {
  role_switch: { limit: 10, windowMs: 60_000 },
  draft_create: { limit: 6, windowMs: 600_000 },
  draft_update: { limit: 30, windowMs: 300_000 },
  report_publish: { limit: 5, windowMs: 600_000 },
  report_archive: { limit: 5, windowMs: 600_000 },
  claim_stage: { limit: 10, windowMs: 600_000 },
  evidence_submit: { limit: 10, windowMs: 600_000 },
  claim_approve: { limit: 10, windowMs: 600_000 },
  claim_reject: { limit: 10, windowMs: 600_000 },
  claim_unlock: { limit: 10, windowMs: 600_000 },
  pickup_issue: { limit: 3, windowMs: 600_000 },
  pickup_reissue: { limit: 3, windowMs: 600_000 },
  handoff: { limit: 5, windowMs: 600_000 },
  match_find: { limit: 15, windowMs: 60_000 },
};

for (const action of RATE_LIMIT_ACTIONS) Object.freeze(policies[action]);
export const INSTANCE_RATE_LIMIT_POLICIES = Object.freeze(policies);
export const ALL_RATE_LIMIT_POLICIES = Object.freeze({
  demo_start: Object.freeze({ limit: 30, windowMs: 60_000 }),
  ...INSTANCE_RATE_LIMIT_POLICIES,
});
