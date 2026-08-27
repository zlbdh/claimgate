import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createClaimService } from "@/features/claims/claim-service";
import { createPickupPassService } from "@/features/claims/pickup-pass-service";
import {
  NOW, ORIGIN, cleanupToolApiTestDatabase,
  expectPrivateResponse as expectPrivate,
  requestToolApi as request,
  setupToolApi as setup,
} from "./tool-api-test-harness";

afterEach(cleanupToolApiTestDatabase);

describe("Task9 tool API state and authorization hardening", () => {
  it("returns STATE_CHANGED outside a reviewable Staff state", async () => {
    const value = setup();
    createClaimService({ repository: value.testDatabase.repository, keyring: value.keyring,
      now: () => NOW }).reject({ demoInstanceId: value.instance.demoInstanceId,
      actorId: "staff-demo", sessionExpiresAt: value.instance.expiresAtMs },
    value.primary.claim.claimId, { expectedClaimVersion: 2,
      idempotencyKey: "tool-api-reject-00001" });
    const response = await value.review(request(
      `/api/staff/claims/${value.primary.claim.claimId}`, value.staff,
    ));
    expect(response.status).toBe(409); expectPrivate(response);
    expect(await response.json()).toMatchObject({ error: { code: "STATE_CHANGED" } });
  });

  it("keeps the five most recent redacted timeline events", async () => {
    const value = setup();
    createClaimService({ repository: value.testDatabase.repository, keyring: value.keyring,
      now: () => NOW }).approve({ demoInstanceId: value.instance.demoInstanceId,
      actorId: "staff-demo", sessionExpiresAt: value.instance.expiresAtMs },
    value.primary.claim.claimId, { expectedClaimVersion: 2,
      expectedItemVersion: value.primary.item.version, idempotencyKey: "timeline-approve-0001" });
    createPickupPassService({ repository: value.testDatabase.repository, keyring: value.keyring,
      now: () => NOW, randomBytes: (size) => Buffer.alloc(size, 94) }).issue({
      demoInstanceId: value.instance.demoInstanceId, actorId: "claimant-demo",
      sessionExpiresAt: value.instance.expiresAtMs }, value.primary.claim.claimId,
    { expectedClaimVersion: 3, idempotencyKey: "timeline-pickup-00001" });
    const response = await value.review(request(
      `/api/staff/claims/${value.primary.claim.claimId}`, value.staff,
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as { timeline: Array<{ action: string }> };
    expect(body.timeline).toHaveLength(5);
    expect(body.timeline.map(({ action }) => action)).toEqual(expect.arrayContaining([
      "APPROVED", "PASS_ISSUED",
    ]));
  });

  it("fails closed across roles, instances, origins, paths, and queries without write quota", async () => {
    const value = setup(); const known = value.primary.claim.claimId;
    const cases: Array<[() => Promise<Response>, number]> = [
      [() => value.pickup(request(`/api/claims/${known}/pickup-instructions`, value.staff)), 403],
      [() => value.pickup(request("/api/claims/unknown/pickup-instructions", value.staff)), 403],
      [() => value.pickup(request("/api/claims/unknown/pickup-instructions", value.claimant)), 404],
      [() => value.queue(request("/api/staff/claims", value.claimant)), 403],
      [() => value.review(request(`/api/staff/claims/${known}`, value.claimant)), 403],
      [() => value.review(request("/api/staff/claims/unknown", value.claimant)), 403],
      [() => value.review(request("/api/staff/claims/unknown", value.staff)), 404],
      [() => value.status(request("/api/claims/unknown", value.claimant)), 404],
      [() => value.status(request("/api/claims/unknown", value.staff)), 404],
      [() => value.status(request(`/api/claims/${value.other.claim.claimId}`, value.claimant)), 404],
      [() => value.status(request(`/api/claims/${value.other.claim.claimId}`, value.staff)), 404],
      [() => value.status(request(`/api/claims/${known}`, value.claimant, "cross-site")), 403],
      [() => value.pickup(request(`/api/claims/${known}/pickup-instructions`, value.claimant, "cross-site")), 403],
      [() => value.queue(request("/api/staff/claims", value.staff, "cross-site")), 403],
      [() => value.review(request(`/api/staff/claims/${known}`, value.staff, "cross-site")), 403],
      [() => value.queue(request("/api/staff/claims?limit=1&limit=2", value.staff)), 403],
      [() => value.queue(request("/api/staff/claims?limit=4", value.staff)), 403],
      [() => value.status(request(`/api/claims/${known}?extra=1`, value.staff)), 403],
      [() => value.pickup(request(`/api/claims/${known}/pickup-instructions?extra=1`, value.claimant)), 403],
      [() => value.review(request(`/api/staff/claims/${known}?extra=1`, value.staff)), 403],
      [() => value.status(request(`/api/claims/${known}%2fextra`, value.staff)), 403],
    ];
    for (const [call, status] of cases) { const response = await call();
      expect(response.status).toBe(status); expectPrivate(response); }
    const missingCookie = await value.status(new Request(`${ORIGIN}/api/claims/${known}`, {
      headers: { host: "example.test", "sec-fetch-site": "same-origin" },
    }));
    expect(missingCookie.status).toBe(401); expectPrivate(missingCookie);
    expect(value.testDatabase.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets").get())
      .toEqual({ count: 0 });
    expect(value.testDatabase.database.prepare("SELECT COUNT(*) AS count FROM consumed_action_nonces").get())
      .toEqual({ count: 0 });
  });
});
