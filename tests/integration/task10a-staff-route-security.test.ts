import { afterEach, describe, expect, it } from "vitest";
import { createRejectClaimRouteHandler } from "@/app/api/staff/claims/[claimId]/reject/route";
import { createUnlockClaimRouteHandler } from "@/app/api/staff/claims/[claimId]/unlock/route";
import {
  createTask10SecurityHarness,
  mintTask10Csrf,
  moveClaimToLocked,
  moveClaimToUnderReview,
  task10FormRequest,
  task10SecuritySnapshot,
  type Task10Harness,
} from "./task10a-security-harness";

type DecisionKind = "reject" | "unlock";
const active: Task10Harness[] = [];

afterEach(() => {
  while (active.length > 0) active.pop()!.close();
});

function setup(kind: DecisionKind) {
  const value = createTask10SecurityHarness();
  active.push(value);
  const prepared = kind === "reject" ? moveClaimToUnderReview(value) : moveClaimToLocked(value);
  const action = kind === "reject" ? "claim_reject" : "claim_unlock";
  const path = `/api/staff/claims/${value.claim.claimId}/${kind}`;
  const handler = kind === "reject"
    ? createRejectClaimRouteHandler(value.dependencies)
    : createUnlockClaimRouteHandler(value.dependencies);
  const body = (key: string) => new URLSearchParams({
    expectedClaimVersion: String(prepared.version),
    idempotencyKey: key,
  });
  return { value, action, path, handler, body } as const;
}

describe("Task 10A physical Staff decision authorization", () => {
  it.each([
    ["reject", "REJECTED"],
    ["unlock", "EVIDENCE_REQUIRED"],
  ] as const)("lets Staff %s once and rejects the replay without another side effect", async (
    kind,
    expectedStatus,
  ) => {
    const route = setup(kind);
    const csrf = mintTask10Csrf(route.value, "staff", route.action, route.path);
    const key = `task10-${kind}-success-0001`;
    const first = await route.handler(task10FormRequest({
      path: route.path,
      sessionToken: route.value.staff.token,
      csrfToken: csrf,
      body: route.body(key),
    }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: expectedStatus });
    const afterFirst = task10SecuritySnapshot(route.value);

    const replay = await route.handler(task10FormRequest({
      path: route.path,
      sessionToken: route.value.staff.token,
      csrfToken: csrf,
      body: route.body(key),
    }));
    expect(replay.status).toBe(403);
    expect(task10SecuritySnapshot(route.value)).toEqual(afterFirst);
  });

  it.each(["reject", "unlock"] as const)(
    "%s rejects Claimant, cross-origin, missing CSRF, and invalid CSRF with zero side effects",
    async (kind) => {
      for (const scenario of ["claimant", "cross-origin", "missing", "invalid"] as const) {
        const route = setup(kind);
        const staffCsrf = mintTask10Csrf(route.value, "staff", route.action, route.path);
        const claimantCsrf = mintTask10Csrf(route.value, "claimant", route.action, route.path);
        const before = task10SecuritySnapshot(route.value);
        const response = await route.handler(task10FormRequest({
          path: route.path,
          sessionToken: scenario === "claimant"
            ? route.value.claimant.token
            : route.value.staff.token,
          csrfToken: scenario === "missing"
            ? undefined
            : scenario === "invalid" ? "invalid-csrf" : scenario === "claimant" ? claimantCsrf : staffCsrf,
          body: route.body(`task10-${kind}-${scenario}-0001`),
          origin: scenario === "cross-origin" ? "https://evil.test" : undefined,
        }));
        expect(response.status, `${kind}/${scenario}`).toBe(403);
        expect(task10SecuritySnapshot(route.value), `${kind}/${scenario}`).toEqual(before);
        route.value.close();
        active.pop();
      }
    },
  );
});
