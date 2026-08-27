import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("specialized pickup issuance idempotency", () => {
  it("returns a token only on the first call and persists only the safe acknowledgement", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const request = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "pickup_issue",
      expectedClaimId: "claim-public",
      idempotencyKey: "pickup-first-call-key",
      requestFingerprint: "pickup-issue-fingerprint-v1",
    } as const;
    const mutation = vi.fn(() => ({
      safeAck: {
        kind: "pickup_pass_ack" as const,
        claimId: "claim-public",
        status: "PICKUP_READY" as const,
        claimVersion: 6,
        generation: 1,
        expiresAtMs: 1_900_000_000_000,
      },
      transientToken: "abcdefghijklmnopqrstuA",
    }));

    const first = testDatabase.repository.runPickupIssuanceIdempotent(request, mutation);
    const replay = testDatabase.repository.runPickupIssuanceIdempotent(request, () => {
      throw new Error("must not replay");
    });
    expect(first).toEqual({
      issuance: "ISSUED",
      ack: mutation.mock.results[0]!.value.safeAck,
      transientToken: "abcdefghijklmnopqrstuA",
    });
    expect(replay).toEqual({
      issuance: "ALREADY_ISSUED",
      ack: mutation.mock.results[0]!.value.safeAck,
    });
    expect(mutation).toHaveBeenCalledOnce();
    const row = testDatabase.database.prepare(`
      SELECT action, result_json AS resultJson FROM idempotency_records
    `).get() as { action: string; resultJson: string };
    expect(row.action).toBe("pickup_issue");
    expect(row.resultJson).toBe(JSON.stringify(mutation.mock.results[0]!.value.safeAck));
    expect(row.resultJson).not.toContain("abcdefghijklmnopqrstuA");
    expect(row.resultJson).not.toMatch(/token|salt|digest/i);
  });

  it("binds action, actor, claim and fingerprint and keeps ordinary idempotency closed", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const request = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "pickup_reissue",
      expectedClaimId: "claim-public",
      idempotencyKey: "pickup-reissue-key",
      requestFingerprint: "pickup-reissue-fingerprint-v1",
    } as const;
    const result = {
      safeAck: {
        kind: "pickup_pass_ack" as const,
        claimId: "claim-public",
        status: "PICKUP_READY" as const,
        claimVersion: 7,
        generation: 2,
        expiresAtMs: 1_900_000_000_001,
      },
      transientToken: "abcdefghijklmnopqrstuQ",
    };
    testDatabase.repository.runPickupIssuanceIdempotent(request, () => result);
    expect(() => testDatabase!.repository.runPickupIssuanceIdempotent(
      { ...request, requestFingerprint: "different" },
      () => result,
    )).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => testDatabase!.repository.runPickupIssuanceIdempotent(
      { ...request, actorId: "staff-demo", idempotencyKey: "staff-key" },
      () => result,
    )).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => testDatabase!.repository.runPickupIssuanceIdempotent(
      { ...request, expectedClaimId: "other", idempotencyKey: "other-claim-key" },
      () => result,
    )).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => testDatabase!.repository.runIdempotent(
      { ...request, action: "pickup_issue" } as never,
      () => result.safeAck as never,
    )).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("rejects non-canonical safe results and token aliases without persisting", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const request = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "pickup_issue",
      expectedClaimId: "claim-public",
      idempotencyKey: "pickup-invalid-key",
      requestFingerprint: "pickup-invalid-fingerprint",
    } as const;
    expect(() => testDatabase!.repository.runPickupIssuanceIdempotent(request, () => ({
      safeAck: {
        kind: "pickup_pass_ack", claimId: "claim-public", status: "PICKUP_READY",
        claimVersion: 1, generation: 1, expiresAtMs: 1, token: "forbidden",
      },
      transientToken: "abcdefghijklmnopqrstuB",
    }) as never)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 0 });
  });

  it("classifies malformed persisted acknowledgements as configuration corruption", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    const request = {
      demoInstanceId: instance.demoInstanceId, actorId: "claimant-demo",
      action: "pickup_issue", expectedClaimId: "claim-public",
      idempotencyKey: "pickup-corrupt-key", requestFingerprint: "pickup-corrupt-fingerprint",
    } as const;
    testDatabase.repository.runPickupIssuanceIdempotent(request, () => ({
      safeAck: {
        kind: "pickup_pass_ack", claimId: "claim-public", status: "PICKUP_READY",
        claimVersion: 2, generation: 1, expiresAtMs: 1000,
      },
      transientToken: "abcdefghijklmnopqrstuA",
    }));
    testDatabase.database.prepare("UPDATE idempotency_records SET result_json = '[]'").run();
    expect(() => testDatabase!.repository.runPickupIssuanceIdempotent(request, () => {
      throw new Error("must not replay");
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });
});
