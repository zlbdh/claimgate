import { Buffer } from "node:buffer";
import { createClaimStatusRouteHandler } from "@/app/api/claims/[claimId]/route";
import { createEvidenceRouteHandler } from "@/app/api/claims/[claimId]/evidence/route";
import { createPickupInstructionsRouteHandler } from "@/app/api/claims/[claimId]/pickup-instructions/route";
import { createIssuePickupPassRouteHandler } from "@/app/api/claims/[claimId]/pickup-pass/issue/route";
import { createApproveClaimRouteHandler } from "@/app/api/staff/claims/[claimId]/approve/route";
import { createPickupHandoffRouteHandler } from "@/app/api/staff/claims/[claimId]/handoff/route";
import { createStaffClaimReviewRouteHandler } from "@/app/api/staff/claims/[claimId]/route";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createTestDatabase, TEST_MASTER_KEY } from "@/server/db/test-harness";
import {
  getAuthenticatedRoute,
  resolveAuthenticatedRoute,
  type AuthenticatedRouteKey,
} from "@/server/http/authenticated-route-registry";
import { parseAppOrigin } from "@/server/http/origin";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { createPrivateEvidenceRecording } from "@/test/record-private-evidence";

export const NOW = Date.UTC(2026, 7, 27, 12);
export const ORIGIN = "https://leak.test";

export function setupLeakFlow() {
  const keyring = createKeyring(TEST_MASTER_KEY);
  const recording = createPrivateEvidenceRecording(keyring);
  const testDatabase = createTestDatabase(NOW, { evidenceDigester: recording.digester });
  const { database, repository } = testDatabase;
  const instance = repository.createDemoInstance();
  const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  const draft = repository.createLostReport({
    demoInstanceId: instance.demoInstanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: "2026-08-27T10:00:00.000Z", to: "2026-08-27T11:00:00.000Z" },
    area: "library",
    color: "black",
    publicTags: ["wireless"],
    publicDescription: "Public lost-item description.",
  });
  const report = repository.publishLostReport({
    demoInstanceId: instance.demoInstanceId,
    reportId: draft.reportId,
    expectedVersion: draft.version,
    actorId: "claimant-demo",
  });
  const claim = repository.createClaim({
    demoInstanceId: instance.demoInstanceId,
    reportId: report.reportId,
    inventoryItemId: item.inventoryItemId,
    claimantActorId: "claimant-demo",
  });
  const sessionSigner = createDemoSessionSigner({
    key: Buffer.alloc(32, 102).toString("base64"),
    now: () => NOW,
  });
  const csrf = createCsrfService({ key: Buffer.alloc(32, 103).toString("base64"), now: () => NOW });
  const dependencies = {
    appOrigin: parseAppOrigin(ORIGIN),
    repository,
    limiter: createPersistentRateLimiter({ database, now: () => NOW }),
    sessionSigner,
    csrf,
    keyring,
    now: () => NOW,
  };
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
  return {
    testDatabase, instance, item, report, claim, dependencies, claimant, staff,
    correctEvidence: recording.answersFor(item.inventoryItemId),
    evidence: createEvidenceRouteHandler(dependencies),
    approve: createApproveClaimRouteHandler(dependencies),
    issue: createIssuePickupPassRouteHandler(dependencies),
    handoff: createPickupHandoffRouteHandler(dependencies),
    status: createClaimStatusRouteHandler(dependencies),
    pickup: createPickupInstructionsRouteHandler(dependencies),
    review: createStaffClaimReviewRouteHandler(dependencies),
  };
}

export function csrfToken(
  value: ReturnType<typeof setupLeakFlow>,
  signed: typeof value.claimant,
  routeKey: AuthenticatedRouteKey,
  path: string,
): string {
  const route = getAuthenticatedRoute(routeKey);
  if (route.method !== "POST" || route.action === null) throw new Error("not a write route");
  const resolved = resolveAuthenticatedRoute(new Request(`${ORIGIN}${path}`, { method: "POST" }), routeKey);
  return value.dependencies.csrf.mint({
    sessionId: signed.claims.sessionId,
    method: "POST",
    routeId: resolved.csrfRouteId,
    action: route.action,
    oneTime: route.requiresOneTime,
    expiresAt: NOW + 60_000,
  });
}

export function postRequest(path: string, token: string, csrf: string, body: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "leak.test",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie: `${DEMO_SESSION_COOKIE}=${token}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-csrf-token": csrf,
    },
    body,
  });
}

export function readRequest(path: string, token: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: {
    host: "leak.test",
    "sec-fetch-site": "same-origin",
    cookie: `${DEMO_SESSION_COOKIE}=${token}`,
  } });
}

export async function capture(response: Response) {
  return Object.freeze({
    url: response.url,
    status: response.status,
    headers: [...response.headers],
    body: await response.text(),
  });
}

export function containsExact(value: unknown, needle: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Buffer.isBuffer(value)) return value.includes(Buffer.from(needle));
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => containsExact(key, needle, seen)
    || containsExact(Reflect.get(value, key), needle, seen));
}

export function allDatabaseRows(database: ReturnType<typeof createTestDatabase>["database"]) {
  return (database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => ({
    name,
    rows: database.prepare(`SELECT * FROM "${name}"`).all(),
  }));
}
