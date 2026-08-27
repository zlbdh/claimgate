type IssuanceExpected = Readonly<{
  claimId: string;
  currentClaimVersion: number;
  expectedGeneration: number;
  now: number;
}>;

type HandoffExpected = Readonly<{
  claimId: string;
  currentClaimVersion: number;
  currentItemVersion: number;
  currentReportVersion: number;
  expectedGeneration: number;
}>;

export type PickupIssuanceClientResponse = Readonly<{
  issuance: "ISSUED";
  claimId: string;
  status: "PICKUP_READY";
  claimVersion: number;
  generation: number;
  expiresAtMs: number;
  token: string;
}> | Readonly<{
  issuance: "ALREADY_ISSUED";
  claimId: string;
  status: "PICKUP_READY";
  claimVersion: number;
  generation: number;
  expiresAtMs: number;
}>;

export type HandoffClientResponse = Readonly<{
  kind: "handoff_ack";
  claimId: string;
  completion: "COLLECTED" | "ALREADY_COLLECTED";
  claimStatus: "COLLECTED";
  claimVersion: number;
  itemStatus: "RETURNED";
  itemVersion: number;
  reportStatus: "RESOLVED";
  reportVersion: number;
  generation: number;
}>;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("invalid pickup response");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new Error("invalid pickup response");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("invalid pickup response");
    }
  }
  return value as Record<string, unknown>;
}

function canonicalToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(value);
}

function validFutureDate(value: unknown, now: number): value is number {
  return Number.isSafeInteger(now)
    && now >= 0
    && Number.isSafeInteger(value)
    && Number(value) > now
    && Number(value) <= now + 600_000
    && Number.isFinite(new Date(Number(value)).getTime());
}

export function parsePickupIssuanceClientResponse(
  value: unknown,
  expected: IssuanceExpected,
): PickupIssuanceClientResponse {
  const common = ["issuance", "claimId", "status", "claimVersion", "generation", "expiresAtMs"];
  const descriptor = value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "issuance")
    : undefined;
  const candidate = descriptor && "value" in descriptor ? descriptor.value : undefined;
  const record = exactRecord(value, candidate === "ISSUED" ? [...common, "token"] : common);
  if (
    !["ISSUED", "ALREADY_ISSUED"].includes(String(record.issuance))
    || record.claimId !== expected.claimId
    || record.status !== "PICKUP_READY"
    || record.claimVersion !== expected.currentClaimVersion + 1
    || record.generation !== expected.expectedGeneration
    || !validFutureDate(record.expiresAtMs, expected.now)
    || (record.issuance === "ISSUED" && !canonicalToken(record.token))
  ) throw new Error("invalid pickup response");
  return Object.freeze({ ...record }) as PickupIssuanceClientResponse;
}

export function parseHandoffClientResponse(
  value: unknown,
  expected: HandoffExpected,
): HandoffClientResponse {
  const record = exactRecord(value, [
    "kind", "claimId", "completion", "claimStatus", "claimVersion",
    "itemStatus", "itemVersion", "reportStatus", "reportVersion", "generation",
  ]);
  if (
    record.kind !== "handoff_ack"
    || record.claimId !== expected.claimId
    || !["COLLECTED", "ALREADY_COLLECTED"].includes(String(record.completion))
    || record.claimStatus !== "COLLECTED"
    || record.claimVersion !== expected.currentClaimVersion + 1
    || record.itemStatus !== "RETURNED"
    || record.itemVersion !== expected.currentItemVersion + 1
    || record.reportStatus !== "RESOLVED"
    || record.reportVersion !== expected.currentReportVersion + 1
    || record.generation !== expected.expectedGeneration
  ) throw new Error("invalid handoff response");
  return Object.freeze({ ...record }) as HandoffClientResponse;
}
