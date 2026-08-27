import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createReportsRouteHandlers } from "@/app/api/reports/route";
import { createClaimService } from "@/features/claims/claim-service";
import { createPickupPassService } from "@/features/claims/pickup-pass-service";
import {
  NOW,
  cleanupToolApiTestDatabase,
  expectPrivateResponse as expectPrivate,
  requestToolApi as request,
  setupToolApi as setup,
} from "./tool-api-test-harness";

afterEach(cleanupToolApiTestDatabase);

describe("Task9 authenticated redacted tool APIs", () => {
  it("returns the exact Claim status shape to its owner and Staff", async () => {
    const value = setup();
    const path = `/api/claims/${value.primary.claim.claimId}`;
    const expectedSteps = ["Wait for Staff review.", "Review aggregate evidence and decide manually."];
    for (const [index, token] of [value.claimant, value.staff].entries()) {
      const response = await value.status(request(path, token));
      expect(response.status).toBe(200);
      expectPrivate(response);
      expect(await response.json()).toEqual({
        claimId: value.primary.claim.claimId,
        status: "UNDER_REVIEW",
        version: 2,
        failedAttempts: 0,
        remainingAttempts: 3,
        evidenceEligible: true,
        unlockCount: 0,
        rejectionReason: null,
        nextStep: expectedSteps[index],
      });
    }
  });

  it("returns the exact owner-only pickup instructions shape", async () => {
    const value = setup();
    createClaimService({
      repository: value.testDatabase.repository, keyring: value.keyring, now: () => NOW,
    }).approve({
      demoInstanceId: value.instance.demoInstanceId,
      actorId: "staff-demo",
      sessionExpiresAt: value.instance.expiresAtMs,
    }, value.primary.claim.claimId, {
      expectedClaimVersion: 2,
      expectedItemVersion: value.primary.item.version,
      idempotencyKey: "tool-api-approve-0001",
    });
    const response = await value.pickup(request(
      `/api/claims/${value.primary.claim.claimId}/pickup-instructions`, value.claimant,
    ));
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({
      claimId: value.primary.claim.claimId,
      deskName: "Northbridge Property Desk · Desk 04",
      hours: "09:00–17:00 · Monday–Friday",
      passReady: false,
      expiresAtMs: null,
      generation: 0,
      status: "APPROVED",
      claimVersion: 3,
    });
    const issued = createPickupPassService({
      repository: value.testDatabase.repository, keyring: value.keyring, now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 91),
    }).issue({
      demoInstanceId: value.instance.demoInstanceId,
      actorId: "claimant-demo",
      sessionExpiresAt: value.instance.expiresAtMs,
    }, value.primary.claim.claimId, {
      expectedClaimVersion: 3,
      idempotencyKey: "tool-api-pickup-0001",
    });
    if (issued.issuance !== "ISSUED") throw new Error("expected a new pickup pass");
    const readyResponse = await value.pickup(request(
      `/api/claims/${value.primary.claim.claimId}/pickup-instructions`, value.claimant,
    ));
    const readyText = await readyResponse.text();
    expect(JSON.parse(readyText)).toEqual({
      claimId: value.primary.claim.claimId,
      deskName: "Northbridge Property Desk · Desk 04",
      hours: "09:00–17:00 · Monday–Friday",
      passReady: true,
      expiresAtMs: NOW + 600_000,
      generation: 1,
      status: "PICKUP_READY",
      claimVersion: 4,
    });
    expect(readyText).not.toContain(issued.token);
  });

  it("returns exact bounded Staff queue and review shapes", async () => {
    const value = setup();
    const queueResponse = await value.queue(request("/api/staff/claims?limit=1", value.staff));
    expect(queueResponse.status).toBe(200);
    expectPrivate(queueResponse);
    expect(await queueResponse.json()).toEqual({
      claims: [{
        claimId: value.primary.claim.claimId,
        status: "UNDER_REVIEW",
        failedAttempts: 0,
        waitingDurationMs: 1_000,
        hasConflict: true,
        item: {
          category: value.primary.item.category,
          area: value.primary.item.area,
          color: value.primary.item.color,
        },
      }],
    });
    const reviewResponse = await value.review(request(
      `/api/staff/claims/${value.primary.claim.claimId}`, value.staff,
    ));
    expect(reviewResponse.status).toBe(200);
    expectPrivate(reviewResponse);
    const review = await reviewResponse.json() as Record<string, unknown>;
    expect(Reflect.ownKeys(review)).toEqual(["claim", "item", "report", "conflict", "timeline"]);
    expect(Reflect.ownKeys(review.claim as object)).toEqual([
      "claimId", "status", "version", "failedAttempts", "remainingAttempts",
      "evidenceEligible", "unlockCount", "generation",
    ]);
    expect(Reflect.ownKeys(review.item as object)).toEqual([
      "category", "area", "color", "publicDescription",
    ]);
    expect(Reflect.ownKeys(review.report as object)).toEqual(["publicDescription", "version"]);
    expect(Reflect.ownKeys(review.conflict as object)).toEqual(["hasConflict", "conflictCount"]);
    expect(review).toMatchObject({
      claim: {
        claimId: value.primary.claim.claimId,
        status: "UNDER_REVIEW",
        version: 2,
        failedAttempts: 0,
        remainingAttempts: 3,
        evidenceEligible: true,
        unlockCount: 0,
        generation: 0,
      },
      item: {
        category: value.primary.item.category,
        area: value.primary.item.area,
        color: value.primary.item.color,
        publicDescription: value.primary.item.publicDescription,
      },
      report: { publicDescription: "public report primary", version: 2 },
      conflict: { hasConflict: true, conflictCount: 1 },
    });
    expect(review.timeline).toHaveLength(5);
    for (const entry of review.timeline as Array<Record<string, unknown>>) {
      expect(Reflect.ownKeys(entry)).toEqual(["action", "actor", "result", "occurredAtMs"]);
    }
    expect(JSON.stringify(review)).not.toContain(value.primary.item.inventoryItemId);
  });

  it("returns only canonical bounded report summaries for list tools", async () => {
    const value = setup();
    const response = await createReportsRouteHandlers(value.dependencies).GET(request(
      "/api/reports?status=PUBLISHED&limit=1",
      value.claimant,
    ));
    expect(response.status).toBe(200);
    expectPrivate(response);
    const body = await response.json() as { reports: Array<Record<string, unknown>> };
    expect(body.reports).toHaveLength(1);
    expect(Reflect.ownKeys(body.reports[0]!)).toEqual([
      "reportId", "category", "timeWindow", "area", "color", "status", "version",
    ]);
    expect(body.reports[0]).toMatchObject({ status: "PUBLISHED" });
  });

});
