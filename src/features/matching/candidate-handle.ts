import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@/shared/domain-error";

const HANDLE_VERSION = "cgch1";
const HANDLE_PURPOSE = "ClaimGate/candidate-handle/cgch1";
const MAX_HANDLE_LIFETIME_SECONDS = 900;
const MAX_HANDLE_LENGTH = 96;

type CandidateBinding = Readonly<{
  key: Buffer;
  ceilingMs: number;
  demoInstanceId: string;
  reportId: string;
  reportVersion: number;
  catalogVersion: number;
  inventoryItemIds: readonly string[];
}>;

export type CandidateHandlePreflight = Readonly<{
  issuedAtSeconds: number;
  expiresAtSeconds: number;
  mac: Buffer;
}>;

const issuedPreflights = new WeakSet<object>();

function validText(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function requireBinding(input: CandidateBinding): void {
  if (
    !Buffer.isBuffer(input.key)
    || input.key.length !== 32
    || !Number.isSafeInteger(input.ceilingMs)
    || input.ceilingMs < 0
    || !validText(input.demoInstanceId)
    || !validText(input.reportId)
    || !Number.isSafeInteger(input.reportVersion)
    || input.reportVersion < 1
    || !Number.isSafeInteger(input.catalogVersion)
    || input.catalogVersion < 1
    || input.inventoryItemIds.length > 3
    || input.inventoryItemIds.some((id) => !validText(id))
    || new Set(input.inventoryItemIds).size !== input.inventoryItemIds.length
  ) throw new DomainError("VALIDATION_FAILED");
}

function lengthPrefixed(fields: readonly string[]): Buffer {
  return Buffer.from(fields.map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`).join("|"), "utf8");
}

function computeMac(input: CandidateBinding, inventoryItemId: string, iat: number, exp: number): Buffer {
  return createHmac("sha256", input.key).update(lengthPrefixed([
    HANDLE_PURPOSE,
    HANDLE_VERSION,
    input.demoInstanceId,
    input.reportId,
    inventoryItemId,
    String(input.reportVersion),
    String(input.catalogVersion),
    String(iat),
    String(exp),
  ])).digest();
}

function parseCanonicalInteger(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseHandle(handle: string): CandidateHandlePreflight {
  if (typeof handle !== "string" || handle.length > MAX_HANDLE_LENGTH) {
    throw new DomainError("VALIDATION_FAILED");
  }
  const parts = handle.split(".");
  const iat = parts[1] === undefined ? undefined : parseCanonicalInteger(parts[1]);
  const exp = parts[2] === undefined ? undefined : parseCanonicalInteger(parts[2]);
  if (
    parts.length !== 4
    || parts[0] !== HANDLE_VERSION
    || iat === undefined
    || exp === undefined
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? "")
  ) throw new DomainError("VALIDATION_FAILED");
  const mac = Buffer.from(parts[3]!, "base64url");
  if (mac.length !== 32 || mac.toString("base64url") !== parts[3]) {
    throw new DomainError("VALIDATION_FAILED");
  }
  return Object.freeze({ issuedAtSeconds: iat, expiresAtSeconds: exp, mac });
}

export function mintCandidateHandles(input: CandidateBinding & { nowMs: number }): string[] {
  requireBinding(input);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new DomainError("VALIDATION_FAILED");
  }
  const issuedAtSeconds = Math.floor(input.nowMs / 1_000);
  const expiresAtSeconds = Math.min(
    issuedAtSeconds + MAX_HANDLE_LIFETIME_SECONDS,
    Math.floor(input.ceilingMs / 1_000),
  );
  if (expiresAtSeconds <= issuedAtSeconds) throw new DomainError("STATE_CHANGED");
  return input.inventoryItemIds.map((inventoryItemId) => {
    const mac = computeMac(input, inventoryItemId, issuedAtSeconds, expiresAtSeconds).toString("base64url");
    return `${HANDLE_VERSION}.${issuedAtSeconds}.${expiresAtSeconds}.${mac}`;
  });
}

export function preflightCandidateHandle(input: {
  handle: string;
  nowMs: number;
}): CandidateHandlePreflight {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new DomainError("VALIDATION_FAILED");
  }
  const parsed = parseHandle(input.handle);
  const nowSeconds = Math.floor(input.nowMs / 1_000);
  if (
    parsed.expiresAtSeconds <= parsed.issuedAtSeconds
    || parsed.expiresAtSeconds - parsed.issuedAtSeconds > MAX_HANDLE_LIFETIME_SECONDS
    || parsed.issuedAtSeconds > nowSeconds
  ) throw new DomainError("VALIDATION_FAILED");
  if (nowSeconds >= parsed.expiresAtSeconds) throw new DomainError("STATE_CHANGED");
  issuedPreflights.add(parsed);
  return parsed;
}

export function resolveCandidateHandle(input: CandidateBinding & {
  preflight: CandidateHandlePreflight;
}): string {
  requireBinding(input);
  if (!issuedPreflights.has(input.preflight)) throw new DomainError("CONFIGURATION_ERROR");
  if (input.preflight.expiresAtSeconds > Math.floor(input.ceilingMs / 1_000)) {
    throw new DomainError("STATE_CHANGED");
  }

  const matches: string[] = [];
  for (const inventoryItemId of input.inventoryItemIds) {
    const expected = computeMac(
      input,
      inventoryItemId,
      input.preflight.issuedAtSeconds,
      input.preflight.expiresAtSeconds,
    );
    const matched = timingSafeEqual(input.preflight.mac, expected);
    if (matched) matches.push(inventoryItemId);
  }
  if (matches.length !== 1) throw new DomainError("STATE_CHANGED");
  return matches[0]!;
}
