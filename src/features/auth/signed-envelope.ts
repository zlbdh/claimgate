import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@/shared/domain-error";

export const MAX_SIGNED_ENVELOPE_LENGTH = 1_024;

export function decodeSigningKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  const key = Buffer.from(value, "base64");
  if (key.length < 32 || key.toString("base64") !== value) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  return key;
}

export function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

export function signSegment(key: Buffer, purpose: string, payload: string): string {
  return createHmac("sha256", key)
    .update(`${purpose}\0${payload}`, "utf8")
    .digest("base64url");
}

export function signatureMatches(
  key: Buffer,
  purpose: string,
  payload: string,
  signature: string,
): boolean {
  const supplied = decodeCanonicalBase64Url(signature);
  const expected = Buffer.from(signSegment(key, purpose, payload), "base64url");
  return Boolean(supplied && supplied.length === expected.length && timingSafeEqual(supplied, expected));
}

export function parseOwnDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
  }
  return value as Record<string, unknown>;
}
