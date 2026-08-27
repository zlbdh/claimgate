import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createSwitchRoleRouteHandler } from "@/app/api/demo/switch-role/route";
import { createCsrfService } from "@/features/auth/csrf";
import {
  createDemoSessionSigner,
  DEMO_SESSION_COOKIE,
  type SignedDemoSession,
} from "@/features/auth/demo-session";
import type { ClaimGateRepository } from "@/server/db/repository";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";

const NOW = Date.UTC(2026, 7, 28, 8);
const ORIGIN = "https://example.test";
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function seedClaim(repository: ClaimGateRepository, demoInstanceId: string) {
  const item = repository.listServerInternalFoundItems(demoInstanceId)[0]!;
  const draft = repository.createLostReport({
    demoInstanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: "a", to: "b" },
    area: "library",
    color: "black",
    publicTags: [],
    publicDescription: "role resume fixture",
  });
  repository.publishLostReport({
    demoInstanceId,
    reportId: draft.reportId,
    expectedVersion: draft.version,
    actorId: "claimant-demo",
  });
  return repository.createClaim({
    demoInstanceId,
    reportId: draft.reportId,
    inventoryItemId: item.inventoryItemId,
    claimantActorId: "claimant-demo",
  });
}

function setup() {
  testDatabase = createTestDatabase(NOW);
  const repository = testDatabase.repository;
  const instance = repository.createDemoInstance();
  const claim = seedClaim(repository, instance.demoInstanceId);
  const otherInstance = repository.createDemoInstance();
  const otherClaim = seedClaim(repository, otherInstance.demoInstanceId);
  const sessionSigner = createDemoSessionSigner({
    key: Buffer.alloc(32, 101).toString("base64"),
    now: () => NOW,
  });
  const csrf = createCsrfService({
    key: Buffer.alloc(32, 102).toString("base64"),
    now: () => NOW,
  });
  const claimant = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role: "CLAIMANT",
    expiresAt: instance.expiresAtMs,
  });
  const staff = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role: "STAFF",
    expiresAt: instance.expiresAtMs,
  });
  const switchRole = createSwitchRoleRouteHandler({
    appOrigin: parseAppOrigin(ORIGIN),
    repository,
    limiter: createPersistentRateLimiter({ database: testDatabase.database, now: () => NOW }),
    sessionSigner,
    csrf,
    now: () => NOW,
  });
  return { claim, otherClaim, claimant, staff, csrf, switchRole };
}

function mintCsrf(value: ReturnType<typeof setup>, signed: SignedDemoSession): string {
  return value.csrf.mint({
    sessionId: signed.claims.sessionId,
    method: "POST",
    routeId: "api.demo.switch-role",
    action: "role_switch",
    expiresAt: NOW + 60_000,
    oneTime: true,
  });
}

function request(signed: SignedDemoSession, entries: Array<[string, string]>) {
  return new Request(`${ORIGIN}/api/demo/switch-role`, {
    method: "POST",
    headers: {
      host: "example.test",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie: `${DEMO_SESSION_COOKIE}=${signed.token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(entries),
  });
}

function switchEntries(
  csrfToken: string,
  targetRole: "CLAIMANT" | "STAFF",
  resumeClaimId?: string,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [["csrfToken", csrfToken], ["targetRole", targetRole]];
  if (resumeClaimId !== undefined) entries.push(["resumeClaimId", resumeClaimId]);
  return entries;
}

function mutationCounts() {
  return {
    nonces: (testDatabase!.database.prepare(
      "SELECT COUNT(*) AS count FROM consumed_action_nonces",
    ).get() as { count: number }).count,
    rate: (testDatabase!.database.prepare(
      "SELECT COALESCE(SUM(request_count), 0) AS count FROM rate_limit_buckets",
    ).get() as { count: number }).count,
  };
}

describe("closed contextual role resume", () => {
  it("keeps the original two-field switch redirecting home", async () => {
    const value = setup();
    const response = await value.switchRole(request(
      value.claimant,
      switchEntries(mintCsrf(value, value.claimant), "STAFF"),
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });

  it.each([
    { from: "claimant", target: "STAFF", prefix: "/staff/claims/" },
    { from: "staff", target: "CLAIMANT", prefix: "/claimant/claims/" },
  ] as const)("derives the $target claim path from a stored claim", async ({ from, target, prefix }) => {
    const value = setup();
    const signed = value[from];
    const response = await value.switchRole(request(
      signed,
      switchEntries(mintCsrf(value, signed), target, value.claim.claimId),
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${prefix}${value.claim.claimId}`);
  });

  it("rolls back an unknown resume so the same token can validly retry", async () => {
    const value = setup();
    const csrfToken = mintCsrf(value, value.claimant);
    const invalid = await value.switchRole(request(
      value.claimant,
      switchEntries(csrfToken, "STAFF", "missing-claim"),
    ));
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("set-cookie")).toBeNull();
    expect(invalid.headers.get("location")).toBeNull();
    expect(mutationCounts()).toEqual({ nonces: 0, rate: 0 });

    const valid = await value.switchRole(request(
      value.claimant,
      switchEntries(csrfToken, "STAFF", value.claim.claimId),
    ));
    expect(valid.status).toBe(303);
    expect(valid.headers.get("location")).toBe(`/staff/claims/${value.claim.claimId}`);
    expect(mutationCounts()).toEqual({ nonces: 1, rate: 1 });
  });

  it("rejects cross-instance and target-Claimant non-owner claims without mutation", async () => {
    const cross = setup();
    const crossResponse = await cross.switchRole(request(
      cross.claimant,
      switchEntries(mintCsrf(cross, cross.claimant), "STAFF", cross.otherClaim.claimId),
    ));
    expect(crossResponse.status).toBe(404);
    expect(mutationCounts()).toEqual({ nonces: 0, rate: 0 });
    testDatabase!.close();
    testDatabase = undefined;

    const nonOwner = setup();
    const nonOwnerId = "claim-owned-by-staff";
    testDatabase!.database.prepare(`
      INSERT INTO claims (
        demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
        status, attempts, evidence_eligible, pass_generation, version
      ) SELECT demo_instance_id, ?, report_id, found_item_id, 'staff-demo',
        'EVIDENCE_REQUIRED', 0, 0, 0, 1
      FROM claims WHERE demo_instance_id = ? AND id = ?
    `).run(nonOwnerId, nonOwner.staff.claims.demoInstanceId, nonOwner.claim.claimId);
    const response = await nonOwner.switchRole(request(
      nonOwner.staff,
      switchEntries(mintCsrf(nonOwner, nonOwner.staff), "CLAIMANT", nonOwnerId),
    ));
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(mutationCounts()).toEqual({ nonces: 0, rate: 0 });
  });

  it.each([
    "",
    "/staff/claims/claim",
    "https://evil.test",
    "claim?next=//evil.test",
    "claim#fragment",
    "x".repeat(129),
  ])("rejects malformed or redirect-shaped resume IDs: %s", async (resumeClaimId) => {
    const value = setup();
    const response = await value.switchRole(request(
      value.claimant,
      switchEntries(mintCsrf(value, value.claimant), "STAFF", resumeClaimId),
    ));
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(mutationCounts()).toEqual({ nonces: 0, rate: 0 });
  });

  it("rejects duplicate and extra resume form keys before mutation", async () => {
    for (const extra of [
      [["resumeClaimId", "second"]] as Array<[string, string]>,
      [["returnTo", "https://evil.test"]] as Array<[string, string]>,
    ]) {
      const value = setup();
      const csrfToken = mintCsrf(value, value.claimant);
      const entries = [...switchEntries(csrfToken, "STAFF", value.claim.claimId), ...extra];
      const response = await value.switchRole(request(value.claimant, entries));
      expect(response.status).toBe(400);
      expect(mutationCounts()).toEqual({ nonces: 0, rate: 0 });
      testDatabase!.close();
      testDatabase = undefined;
    }
  });

  it("allows only one successful concurrent replay with resume context", async () => {
    const value = setup();
    const csrfToken = mintCsrf(value, value.claimant);
    const responses = await Promise.all(Array.from({ length: 2 }, () => value.switchRole(request(
      value.claimant,
      switchEntries(csrfToken, "STAFF", value.claim.claimId),
    ))));
    expect(responses.map(({ status }) => status).sort()).toEqual([303, 403]);
    expect(responses.filter(({ status }) => status === 303)[0]!.headers.get("location"))
      .toBe(`/staff/claims/${value.claim.claimId}`);
    expect(mutationCounts()).toEqual({ nonces: 1, rate: 1 });
  });
});
