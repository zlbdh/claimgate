import { describe, expect, it } from "vitest";
import { RATE_LIMIT_ACTIONS } from "./rate-limit";
import {
  ALL_RATE_LIMIT_POLICIES,
  INSTANCE_RATE_LIMIT_POLICIES,
} from "./rate-limit-policy";

const EXPECTED_INSTANCE_POLICIES = Object.freeze({
  role_switch: { limit: 10, windowMs: 60_000 },
  draft_create: { limit: 6, windowMs: 600_000 },
  draft_update: { limit: 30, windowMs: 300_000 },
  report_publish: { limit: 5, windowMs: 600_000 },
  report_archive: { limit: 5, windowMs: 600_000 },
  claim_stage: { limit: 10, windowMs: 600_000 },
  evidence_submit: { limit: 5, windowMs: 600_000 },
  claim_approve: { limit: 10, windowMs: 600_000 },
  claim_reject: { limit: 10, windowMs: 600_000 },
  claim_unlock: { limit: 10, windowMs: 600_000 },
  pickup_issue: { limit: 3, windowMs: 600_000 },
  pickup_reissue: { limit: 3, windowMs: 600_000 },
  handoff: { limit: 5, windowMs: 600_000 },
  match_find: { limit: 15, windowMs: 60_000 },
});

describe("冻结的完整限流策略矩阵", () => {
  it("精确覆盖 14 个 instance actions，另含 pre-instance demo_start", () => {
    expect(INSTANCE_RATE_LIMIT_POLICIES).toEqual(EXPECTED_INSTANCE_POLICIES);
    expect(Object.keys(INSTANCE_RATE_LIMIT_POLICIES)).toEqual([...RATE_LIMIT_ACTIONS]);
    expect(ALL_RATE_LIMIT_POLICIES).toEqual({
      demo_start: { limit: 30, windowMs: 60_000 },
      ...EXPECTED_INSTANCE_POLICIES,
    });
    expect(Object.isFrozen(INSTANCE_RATE_LIMIT_POLICIES)).toBe(true);
    expect(Object.isFrozen(ALL_RATE_LIMIT_POLICIES)).toBe(true);
  });
});
