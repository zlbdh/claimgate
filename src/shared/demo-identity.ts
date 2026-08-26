export const DEMO_ROLES = Object.freeze(["CLAIMANT", "STAFF"] as const);
export type DemoRole = (typeof DEMO_ROLES)[number];

export const DEMO_IDENTITIES = Object.freeze({
  CLAIMANT: Object.freeze({ role: "CLAIMANT", userId: "claimant-demo" }),
  STAFF: Object.freeze({ role: "STAFF", userId: "staff-demo" }),
} as const);

export type DemoUserId = (typeof DEMO_IDENTITIES)[DemoRole]["userId"];

export function isDemoRole(value: unknown): value is DemoRole {
  return typeof value === "string" && DEMO_ROLES.includes(value as DemoRole);
}

export function isDemoUserId(value: unknown): value is DemoUserId {
  return value === DEMO_IDENTITIES.CLAIMANT.userId || value === DEMO_IDENTITIES.STAFF.userId;
}
