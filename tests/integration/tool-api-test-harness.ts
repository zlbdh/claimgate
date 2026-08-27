import { Buffer } from "node:buffer";
import { expect } from "vitest";
import { createClaimStatusRouteHandler } from "@/app/api/claims/[claimId]/route";
import { createPickupInstructionsRouteHandler } from "@/app/api/claims/[claimId]/pickup-instructions/route";
import { createStaffClaimsRouteHandler } from "@/app/api/staff/claims/route";
import { createStaffClaimReviewRouteHandler } from "@/app/api/staff/claims/[claimId]/route";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createCsrfService } from "@/features/auth/csrf";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";

export const NOW = Date.UTC(2026, 7, 27, 10);
export const ORIGIN = "https://example.test";
const KEY = Buffer.alloc(32, 71).toString("base64");
let activeDatabase: TestDatabase | undefined;

export function cleanupToolApiTestDatabase(): void {
  activeDatabase?.close();
  activeDatabase = undefined;
}

function createPublishedClaim(
  repository: TestDatabase["repository"],
  instanceId: string,
  suffix: string,
) {
  const item = repository.listServerInternalFoundItems(instanceId)[0]!;
  const report = repository.createLostReport({
    demoInstanceId: instanceId, ownerActorId: "claimant-demo", category: "earbuds",
    timeWindow: { from: "2026-08-27T01:00:00.000Z", to: "2026-08-27T02:00:00.000Z" },
    area: "library", color: "black", publicTags: [], publicDescription: `public report ${suffix}`,
  });
  const published = repository.publishLostReport({
    demoInstanceId: instanceId, reportId: report.reportId,
    expectedVersion: report.version, actorId: "claimant-demo",
  });
  const claim = repository.createClaim({
    demoInstanceId: instanceId, reportId: report.reportId,
    inventoryItemId: item.inventoryItemId, claimantActorId: "claimant-demo",
  });
  return { item, report: published, claim };
}

export function setupToolApi() {
  activeDatabase = createTestDatabase(NOW);
  const testDatabase = activeDatabase;
  const { repository, database } = testDatabase;
  const keyring = createKeyring(KEY);
  const instance = repository.createDemoInstance();
  const primary = createPublishedClaim(repository, instance.demoInstanceId, "primary");
  createPublishedClaim(repository, instance.demoInstanceId, "competitor");
  database.prepare(`UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1,
    version = version + 1 WHERE demo_instance_id = ? AND id = ?`)
    .run(instance.demoInstanceId, primary.claim.claimId);
  database.prepare(`INSERT INTO claim_events (
    demo_instance_id, id, claim_id, event_type, actor_id, result, occurred_at_ms
  ) VALUES (?, 'tool-api-eligible', ?, 'EVIDENCE_ELIGIBLE', 'claimant-demo', 'ELIGIBLE', ?)`)
    .run(instance.demoInstanceId, primary.claim.claimId, NOW - 1_000);
  for (let index = 0; index < 6; index += 1) {
    database.prepare(`INSERT INTO claim_events (
      demo_instance_id, id, claim_id, event_type, actor_id, result, occurred_at_ms
    ) VALUES (?, ?, ?, 'EVIDENCE_INSUFFICIENT', 'claimant-demo', 'INSUFFICIENT', ?)`)
      .run(instance.demoInstanceId, `tool-api-event-${index}`, primary.claim.claimId, NOW - 900 + index);
  }
  const otherInstance = repository.createDemoInstance();
  const other = createPublishedClaim(repository, otherInstance.demoInstanceId, "other-instance");
  const sessionSigner = createDemoSessionSigner({
    key: Buffer.alloc(32, 72).toString("base64"), now: () => NOW,
  });
  const dependencies = {
    appOrigin: parseAppOrigin(ORIGIN), repository,
    limiter: createPersistentRateLimiter({ database, now: () => NOW }), sessionSigner,
    csrf: createCsrfService({ key: Buffer.alloc(32, 73).toString("base64"), now: () => NOW }),
    keyring, now: () => NOW,
  };
  return {
    testDatabase, instance, other, primary, keyring, dependencies,
    status: createClaimStatusRouteHandler(dependencies),
    pickup: createPickupInstructionsRouteHandler(dependencies),
    queue: createStaffClaimsRouteHandler(dependencies),
    review: createStaffClaimReviewRouteHandler(dependencies),
    claimant: sessionSigner.mint({
      demoInstanceId: instance.demoInstanceId, role: "CLAIMANT", expiresAt: instance.expiresAtMs,
    }).token,
    staff: sessionSigner.mint({
      demoInstanceId: instance.demoInstanceId, role: "STAFF", expiresAt: instance.expiresAtMs,
    }).token,
  };
}

export function requestToolApi(path: string, token: string, fetchSite = "same-origin") {
  return new Request(`${ORIGIN}${path}`, { headers: {
    host: "example.test", "sec-fetch-site": fetchSite,
    cookie: `${DEMO_SESSION_COOKIE}=${token}`,
  } });
}

export function expectPrivateResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}
