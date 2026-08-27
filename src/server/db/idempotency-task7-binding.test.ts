import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup() {
  testDatabase = createTestDatabase();
  const instance = testDatabase.repository.createDemoInstance();
  return { repository: testDatabase.repository, instance };
}

function request(action: "evidence_submit" | "claim_approve" | "claim_reject" | "claim_unlock") {
  const value = setup();
  return {
    ...value,
    request: {
      demoInstanceId: value.instance.demoInstanceId,
      actorId: action === "evidence_submit" ? "claimant-demo" as const : "staff-demo" as const,
      action,
      idempotencyKey: `binding-${action}-0001`,
      requestFingerprint: `fingerprint-${action}`,
      expectedClaimId: "claim-expected",
    },
  };
}

const valid = {
  evidence_submit: {
    kind: "claim_state_ack", claimId: "claim-expected", status: "EVIDENCE_REQUIRED",
    version: 2, failedAttempts: 1, evidenceEligible: false, unlockCount: 0, rejectionReason: null,
  },
  claim_approve: {
    kind: "claim_state_ack", claimId: "claim-expected", status: "APPROVED",
    version: 2, failedAttempts: 0, evidenceEligible: true, unlockCount: 0, rejectionReason: null,
  },
  claim_reject: {
    kind: "claim_state_ack", claimId: "claim-expected", status: "REJECTED",
    version: 2, failedAttempts: 0, evidenceEligible: true, unlockCount: 0,
    rejectionReason: "STAFF_REJECTED",
  },
  claim_unlock: {
    kind: "claim_state_ack", claimId: "claim-expected", status: "EVIDENCE_REQUIRED",
    version: 2, failedAttempts: 0, evidenceEligible: false, unlockCount: 1, rejectionReason: null,
  },
} as const;

describe("Task 7 idempotency result resource binding", () => {
  it.each(Object.keys(valid) as Array<keyof typeof valid>)("accepts the exact %s acknowledgement", (action) => {
    const value = request(action);
    expect(value.repository.runIdempotent(value.request, () => ({ ...valid[action] }))).toEqual(valid[action]);
  });

  it("rejects a callback acknowledgement for another Claim before INSERT", () => {
    const value = request("evidence_submit");
    expect(() => value.repository.runIdempotent(value.request, () => ({
      ...valid.evidence_submit,
      claimId: "claim-other",
    }))).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 0 });
  });

  it.each([
    ["evidence_submit", { ...valid.evidence_submit, failedAttempts: 0 }],
    ["evidence_submit", { ...valid.evidence_submit, status: "UNDER_REVIEW", evidenceEligible: false }],
    ["evidence_submit", { ...valid.evidence_submit, status: "LOCKED", failedAttempts: 2 }],
    ["claim_approve", { ...valid.claim_approve, evidenceEligible: false }],
    ["claim_reject", { ...valid.claim_reject, rejectionReason: null }],
    ["claim_unlock", { ...valid.claim_unlock, unlockCount: 0 }],
  ] as const)("rejects impossible %s combinations", (action, result) => {
    const value = request(action);
    expect(() => value.repository.runIdempotent(value.request, () => ({ ...result })))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 0 });
  });

  it("does not coerce a non-primitive status through toString or valueOf", () => {
    const value = request("evidence_submit");
    let calls = 0;
    const status = Object.defineProperties({}, {
      toString: { value: () => { calls += 1; return "EVIDENCE_REQUIRED"; } },
      valueOf: { value: () => { calls += 1; return "EVIDENCE_REQUIRED"; } },
    });
    expect(() => value.repository.runIdempotent(value.request, () => ({
      ...valid.evidence_submit,
      status: status as never,
    }))).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(calls).toBe(0);
  });
});
