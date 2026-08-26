import { Buffer } from "node:buffer";
import { createHmac, randomBytes as secureRandomBytes } from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import {
  decodeCanonicalBase64Url,
  decodeSigningKey,
  encodeBase64Url,
  MAX_SIGNED_ENVELOPE_LENGTH,
  parseOwnDataRecord,
  signatureMatches,
  signSegment,
} from "./signed-envelope";

const VERSION = "v1";
const PURPOSE = "ClaimGate/csrf/v1";
const NONCE_PURPOSE = "ClaimGate/csrf-nonce/v1";
const MAX_CSRF_LIFETIME_MS = 10 * 60 * 1_000;

type CsrfBinding = {
  sessionId: string;
  method: string;
  routeId: string;
  action: string;
};

export type CsrfMetadata = Readonly<{
  oneTime: boolean;
  expiresAt: number;
  nonceDigest: Buffer;
}>;

function validBinding(value: CsrfBinding): boolean {
  return typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 128
    && /^(GET|POST|PUT|PATCH|DELETE)$/.test(value.method)
    && /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(value.routeId) && value.routeId.length <= 128
    && /^[a-z][a-z0-9_]{0,63}$/.test(value.action);
}

function signaturePayload(binding: CsrfBinding, payloadSegment: string): string {
  return [binding.sessionId, binding.method, binding.routeId, binding.action, payloadSegment]
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("|");
}

export function createCsrfService(options: {
  key?: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}) {
  const key = decodeSigningKey(options.key);
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? secureRandomBytes;

  const mint = (input: CsrfBinding & { expiresAt: number; oneTime: boolean }): string => {
    const currentTime = now();
    if (
      !validBinding(input)
      || !Number.isSafeInteger(currentTime)
      || !Number.isSafeInteger(input.expiresAt)
      || input.expiresAt <= currentTime
      || input.expiresAt - currentTime > MAX_CSRF_LIFETIME_MS
      || typeof input.oneTime !== "boolean"
    ) throw new DomainError("VALIDATION_FAILED");
    const payloadRecord = {
      n: encodeBase64Url(randomBytes(32)),
      m: input.method,
      p: input.routeId,
      a: input.action,
      o: input.oneTime,
      exp: input.expiresAt,
    };
    const payload = encodeBase64Url(JSON.stringify(payloadRecord));
    const signature = signSegment(key, PURPOSE, signaturePayload(input, payload));
    const token = `${VERSION}.${payload}.${signature}`;
    if (token.length > MAX_SIGNED_ENVELOPE_LENGTH) throw new DomainError("CONFIGURATION_ERROR");
    return token;
  };

  const verify = (input: CsrfBinding & { token: string | undefined }): CsrfMetadata => {
    try {
      if (!validBinding(input) || !input.token || input.token.length > MAX_SIGNED_ENVELOPE_LENGTH) {
        throw new Error();
      }
      const parts = input.token.split(".");
      if (parts.length !== 3 || parts[0] !== VERSION) throw new Error();
      const bytes = decodeCanonicalBase64Url(parts[1]);
      if (!bytes || !signatureMatches(key, PURPOSE, signaturePayload(input, parts[1]), parts[2])) {
        throw new Error();
      }
      const record = parseOwnDataRecord(JSON.parse(bytes.toString("utf8")) as unknown, [
        "n", "m", "p", "a", "o", "exp",
      ]);
      const currentTime = now();
      if (
        !record
        || record.m !== input.method
        || record.p !== input.routeId
        || record.a !== input.action
        || typeof record.o !== "boolean"
        || !Number.isSafeInteger(record.exp)
        || !Number.isSafeInteger(currentTime)
        || (record.exp as number) <= currentTime
        || (record.exp as number) - currentTime > MAX_CSRF_LIFETIME_MS
        || typeof record.n !== "string"
      ) throw new Error();
      const nonce = decodeCanonicalBase64Url(record.n);
      if (!nonce || nonce.length !== 32) throw new Error();
      const canonical = { n: record.n, m: record.m, p: record.p, a: record.a, o: record.o, exp: record.exp };
      if (encodeBase64Url(JSON.stringify(canonical)) !== parts[1]) throw new Error();
      const nonceDigest = createHmac("sha256", key).update(NONCE_PURPOSE).update(nonce).digest();
      return Object.freeze({
        oneTime: record.o,
        expiresAt: record.exp as number,
        nonceDigest,
      });
    } catch {
      throw new DomainError("FORBIDDEN");
    }
  };

  return Object.freeze({ mint, verify });
}

export type CsrfService = ReturnType<typeof createCsrfService>;
