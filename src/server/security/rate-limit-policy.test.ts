import { describe, expect, it } from "vitest";
import { RATE_LIMIT_ACTIONS } from "./rate-limit";
import { AUTHENTICATED_ROUTE_REGISTRY } from "@/server/http/authenticated-route-registry";
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
  evidence_submit: { limit: 10, windowMs: 600_000 },
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
    for (const policy of Object.values(ALL_RATE_LIMIT_POLICIES)) {
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });

  it("authenticated route registry 闭合 method/path/action/roles/one-time/policy", () => {
    expect(AUTHENTICATED_ROUTE_REGISTRY).toEqual({
      "api.demo.switch-role": {
        method: "POST",
        path: "/api/demo/switch-role",
        action: "role_switch",
        allowedRoles: ["CLAIMANT", "STAFF"],
        requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.role_switch,
      },
      "api.reports.create": {
        method: "POST", path: "/api/reports", action: "draft_create",
        allowedRoles: ["CLAIMANT"], requiresOneTime: false,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.draft_create,
      },
      "api.reports.update": {
        method: "POST", path: "/api/reports/:reportId", action: "draft_update",
        allowedRoles: ["CLAIMANT"], requiresOneTime: false,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.draft_update,
      },
      "api.reports.publish": {
        method: "POST", path: "/api/reports/:reportId/publish", action: "report_publish",
        allowedRoles: ["CLAIMANT"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.report_publish,
      },
      "api.reports.archive": {
        method: "POST", path: "/api/reports/:reportId/archive", action: "report_archive",
        allowedRoles: ["CLAIMANT"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.report_archive,
      },
      "api.reports.list": {
        method: "GET", path: "/api/reports", action: null,
        allowedRoles: ["CLAIMANT"], requiresOneTime: false, ratePolicy: null,
      },
      "api.reports.matches": {
        method: "GET", path: "/api/reports/:reportId/matches", action: "match_find",
        allowedRoles: ["CLAIMANT"], requiresOneTime: false,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.match_find,
      },
      "api.claims.stage": {
        method: "POST", path: "/api/claims", action: "claim_stage",
        allowedRoles: ["CLAIMANT"], requiresOneTime: false,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.claim_stage,
      },
      "api.claims.status": {
        method: "GET", path: "/api/claims/:claimId", action: null,
        allowedRoles: ["CLAIMANT", "STAFF"], requiresOneTime: false, ratePolicy: null,
      },
      "api.claims.pickup.instructions": {
        method: "GET", path: "/api/claims/:claimId/pickup-instructions", action: null,
        allowedRoles: ["CLAIMANT"], requiresOneTime: false, ratePolicy: null,
      },
      "api.claims.evidence": {
        method: "POST", path: "/api/claims/:claimId/evidence", action: "evidence_submit",
        allowedRoles: ["CLAIMANT"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.evidence_submit,
      },
      "api.claims.pickup.issue": {
        method: "POST", path: "/api/claims/:claimId/pickup-pass/issue", action: "pickup_issue",
        allowedRoles: ["CLAIMANT"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.pickup_issue,
      },
      "api.claims.pickup.reissue": {
        method: "POST", path: "/api/claims/:claimId/pickup-pass/reissue", action: "pickup_reissue",
        allowedRoles: ["CLAIMANT"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.pickup_reissue,
      },
      "api.staff.claims.approve": {
        method: "POST", path: "/api/staff/claims/:claimId/approve", action: "claim_approve",
        allowedRoles: ["STAFF"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.claim_approve,
      },
      "api.staff.claims.reject": {
        method: "POST", path: "/api/staff/claims/:claimId/reject", action: "claim_reject",
        allowedRoles: ["STAFF"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.claim_reject,
      },
      "api.staff.claims.unlock": {
        method: "POST", path: "/api/staff/claims/:claimId/unlock", action: "claim_unlock",
        allowedRoles: ["STAFF"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.claim_unlock,
      },
      "api.staff.claims.handoff": {
        method: "POST", path: "/api/staff/claims/:claimId/handoff", action: "handoff",
        allowedRoles: ["STAFF"], requiresOneTime: true,
        ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.handoff,
      },
      "api.staff.claims.list": {
        method: "GET", path: "/api/staff/claims", action: null,
        allowedRoles: ["STAFF"], requiresOneTime: false, ratePolicy: null,
      },
      "api.staff.claims.review": {
        method: "GET", path: "/api/staff/claims/:claimId", action: null,
        allowedRoles: ["STAFF"], requiresOneTime: false, ratePolicy: null,
      },
    });
    expect(Object.isFrozen(AUTHENTICATED_ROUTE_REGISTRY)).toBe(true);
    const route = AUTHENTICATED_ROUTE_REGISTRY["api.demo.switch-role"];
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.allowedRoles)).toBe(true);
    expect(route.ratePolicy).toBe(INSTANCE_RATE_LIMIT_POLICIES.role_switch);
  });
});
