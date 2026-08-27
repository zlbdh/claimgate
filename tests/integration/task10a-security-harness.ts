import { Buffer } from "node:buffer";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createCsrfService } from "@/features/auth/csrf";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter, type RateLimitAction } from "@/server/security/rate-limit";
import { createTestDatabase, TEST_MASTER_KEY } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";

export const TASK10_NOW = Date.UTC(2026, 7, 27, 12);
export const TASK10_ORIGIN = "https://example.test";
const SESSION_KEY = Buffer.alloc(32, 121).toString("base64");
const CSRF_KEY = Buffer.alloc(32, 122).toString("base64");

export function createTask10SecurityHarness(sessionExpiresAt?: number) {
  let sessionNow = TASK10_NOW;
  const testDatabase = createTestDatabase(TASK10_NOW);
  const { repository, database } = testDatabase;
  const keyring = createKeyring(TEST_MASTER_KEY);
  const instance = repository.createDemoInstance();
  const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  const draft = repository.createLostReport({
    demoInstanceId: instance.demoInstanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: {
      from: "2026-08-27T09:00:00.000Z",
      to: "2026-08-27T10:00:00.000Z",
    },
    area: "library",
    color: "black",
    publicTags: [],
    publicDescription: "Task 10 route fixture.",
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
  const sessionSigner = createDemoSessionSigner({ key: SESSION_KEY, now: () => sessionNow });
  const csrf = createCsrfService({ key: CSRF_KEY, now: () => sessionNow });
  const expiry = sessionExpiresAt ?? instance.expiresAtMs;
  const claimant = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role: "CLAIMANT",
    expiresAt: expiry,
  });
  const staff = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role: "STAFF",
    expiresAt: expiry,
  });
  const dependencies = {
    appOrigin: parseAppOrigin(TASK10_ORIGIN),
    repository,
    limiter: createPersistentRateLimiter({ database, now: () => sessionNow }),
    sessionSigner,
    csrf,
    keyring,
    now: () => sessionNow,
  };
  return {
    testDatabase,
    database,
    repository,
    instance,
    item,
    report,
    claim,
    claimant,
    staff,
    csrf,
    dependencies,
    setSessionNow(value: number) { sessionNow = value; },
    close() { testDatabase.close(); },
  };
}

export type Task10Harness = ReturnType<typeof createTask10SecurityHarness>;

export function moveClaimToUnderReview(value: Task10Harness) {
  return value.repository.recordEvidenceOutcome({
    demoInstanceId: value.instance.demoInstanceId,
    claimId: value.claim.claimId,
    claimantActorId: "claimant-demo",
    expectedClaimVersion: value.claim.version,
    outcome: "ELIGIBLE_FOR_REVIEW",
  });
}

export function moveClaimToLocked(value: Task10Harness) {
  let version = value.claim.version;
  for (const outcome of ["INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE", "LOCKED"] as const) {
    version = value.repository.recordEvidenceOutcome({
      demoInstanceId: value.instance.demoInstanceId,
      claimId: value.claim.claimId,
      claimantActorId: "claimant-demo",
      expectedClaimVersion: version,
      outcome,
    }).version;
  }
  return value.repository.getClaim(value.instance.demoInstanceId, value.claim.claimId);
}

export function mintTask10Csrf(
  value: Task10Harness,
  role: "claimant" | "staff",
  action: RateLimitAction,
  path: string,
) {
  return value.csrf.mint({
    sessionId: value[role].claims.sessionId,
    method: "POST",
    routeId: path.slice(1),
    action,
    expiresAt: TASK10_NOW + 60_000,
    oneTime: true,
  });
}

export function task10FormRequest(input: {
  path: string;
  sessionToken: string;
  body: BodyInit;
  csrfToken?: string;
  origin?: string;
  contentType?: string | null;
}) {
  const origin = input.origin ?? TASK10_ORIGIN;
  const headers = new Headers({
    host: "example.test",
    origin,
    "sec-fetch-site": origin === TASK10_ORIGIN ? "same-origin" : "cross-site",
    cookie: `${DEMO_SESSION_COOKIE}=${input.sessionToken}`,
  });
  if (input.csrfToken !== undefined) headers.set("x-csrf-token", input.csrfToken);
  if (input.contentType !== null) {
    headers.set("content-type", input.contentType ?? "application/x-www-form-urlencoded");
  }
  return new Request(`${TASK10_ORIGIN}${input.path}`, {
    method: "POST",
    headers,
    body: input.body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export function task10SecuritySnapshot(value: Task10Harness) {
  return {
    claim: value.database.prepare("SELECT * FROM claims WHERE demo_instance_id = ? AND id = ?")
      .get(value.instance.demoInstanceId, value.claim.claimId),
    events: value.database.prepare("SELECT * FROM claim_events ORDER BY id").all(),
    quota: value.database.prepare("SELECT * FROM rate_limit_buckets ORDER BY action, window_start_ms").all(),
    nonces: value.database.prepare("SELECT * FROM consumed_action_nonces ORDER BY action").all(),
    idempotency: value.database.prepare("SELECT * FROM idempotency_records ORDER BY action").all(),
  };
}
