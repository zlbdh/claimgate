import { afterEach, describe, expect, it } from "vitest";
import { createClaimStatusRouteHandler } from "@/app/api/claims/[claimId]/route";
import { createClaimsRouteHandler } from "@/app/api/claims/route";
import { DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import {
  createTask10SecurityHarness,
  TASK10_NOW,
  TASK10_ORIGIN,
  task10FormRequest,
  task10SecuritySnapshot,
  type Task10Harness,
} from "./task10a-security-harness";

const active: Task10Harness[] = [];

afterEach(() => {
  while (active.length > 0) active.pop()!.close();
});

function setup(sessionExpiresAt?: number) {
  const value = createTask10SecurityHarness(sessionExpiresAt);
  active.push(value);
  return value;
}

function getRequest(path: string, token: string) {
  return new Request(`${TASK10_ORIGIN}${path}`, { headers: {
    host: "example.test",
    "sec-fetch-site": "same-origin",
    cookie: `${DEMO_SESSION_COOKIE}=${token}`,
  } });
}

function countedBody(chunkFactory: (pull: number) => Uint8Array | undefined) {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      const chunk = chunkFactory(pulls);
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

function stageRequest(
  value: Task10Harness,
  body: BodyInit,
  contentType: string | null = "application/json",
) {
  return task10FormRequest({
    path: "/api/claims",
    sessionToken: value.claimant.token,
    body,
    contentType,
  });
}

describe("Task 10A expired session at physical routes", () => {
  it("returns the same 401 for known and unknown authenticated GET resources", async () => {
    const expiresAt = TASK10_NOW + 1_000;
    const value = setup(expiresAt);
    value.setSessionNow(expiresAt);
    const handler = createClaimStatusRouteHandler(value.dependencies);
    const responses = await Promise.all([
      handler(getRequest(`/api/claims/${value.claim.claimId}`, value.claimant.token)),
      handler(getRequest("/api/claims/unknown", value.claimant.token)),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([401, 401]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(bodies[1]).toBe(bodies[0]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(task10SecuritySnapshot(value).quota).toEqual([]);
    expect(task10SecuritySnapshot(value).nonces).toEqual([]);
  });

  it("rejects an expired authenticated POST before reading its stream or writing state", async () => {
    const expiresAt = TASK10_NOW + 1_000;
    const value = setup(expiresAt);
    value.setSessionNow(expiresAt);
    const counted = countedBody((pull) => pull === 1
      ? new TextEncoder().encode("{\"reportId\":\"private\"}")
      : undefined);
    const request = stageRequest(value, counted.stream);
    await Promise.resolve();
    const pullsBefore = counted.pulls();
    const before = task10SecuritySnapshot(value);
    const response = await createClaimsRouteHandler(value.dependencies)(request);
    expect(response.status).toBe(401);
    expect(counted.pulls()).toBe(pullsBefore);
    expect(request.bodyUsed).toBe(false);
    expect(task10SecuritySnapshot(value)).toEqual(before);
  });
});

describe("Task 10A strict JSON claim-stage boundary", () => {
  it("rejects declared 4097 bytes without reading the body or entering a transaction", async () => {
    const value = setup();
    const counted = countedBody((pull) => pull === 1 ? new Uint8Array(8) : undefined);
    const request = stageRequest(value, counted.stream);
    request.headers.set("content-length", "4097");
    await Promise.resolve();
    const pullsBefore = counted.pulls();
    const before = task10SecuritySnapshot(value);
    const response = await createClaimsRouteHandler(value.dependencies)(request);
    expect(response.status).toBe(400);
    expect(counted.pulls()).toBe(pullsBefore);
    expect(request.bodyUsed).toBe(false);
    expect(task10SecuritySnapshot(value)).toEqual(before);
  });

  it("cancels an actual chunked overflow and leaves every transaction table unchanged", async () => {
    const value = setup();
    const counted = countedBody(() => new Uint8Array(3_000));
    const before = task10SecuritySnapshot(value);
    const response = await createClaimsRouteHandler(value.dependencies)(
      stageRequest(value, counted.stream),
    );
    expect(response.status).toBe(400);
    expect(counted.cancelled()).toBe(true);
    expect(counted.pulls()).toBeLessThanOrEqual(4);
    expect(task10SecuritySnapshot(value)).toEqual(before);
  });

  it("rejects fatal UTF-8 before quota, idempotency, nonce, or Claim writes", async () => {
    const value = setup();
    const before = task10SecuritySnapshot(value);
    const response = await createClaimsRouteHandler(value.dependencies)(
      stageRequest(value, Uint8Array.from([0xc3, 0x28])),
    );
    expect(response.status).toBe(400);
    expect(task10SecuritySnapshot(value)).toEqual(before);
  });

  it.each([null, "text/plain", "application/json; charset=latin1"])(
    "rejects missing or wrong Content-Type %s without reading the body",
    async (contentType) => {
      const value = setup();
      const counted = countedBody((pull) => pull === 1 ? new TextEncoder().encode("{}") : undefined);
      const request = stageRequest(value, counted.stream, contentType);
      await Promise.resolve();
      const pullsBefore = counted.pulls();
      const before = task10SecuritySnapshot(value);
      const response = await createClaimsRouteHandler(value.dependencies)(request);
      expect(response.status).toBe(400);
      expect(counted.pulls()).toBe(pullsBefore);
      expect(request.bodyUsed).toBe(false);
      expect(task10SecuritySnapshot(value)).toEqual(before);
      value.close();
      active.pop();
    },
  );
});
