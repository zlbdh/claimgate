import { Buffer } from "node:buffer";
import { randomBytes as secureRandomBytes } from "node:crypto";
import { DEMO_IDENTITIES, isDemoRole, type DemoRole, type DemoUserId } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import { parseCanonicalAppOrigin } from "@/shared/app-origin";
import {
  decodeCanonicalBase64Url,
  decodeSigningKey,
  encodeBase64Url,
  MAX_SIGNED_ENVELOPE_LENGTH,
  parseOwnDataRecord,
  signatureMatches,
  signSegment,
} from "./signed-envelope";

export const DEMO_SESSION_COOKIE = "claimgate_session";
const VERSION = "v1";
const PURPOSE = "ClaimGate/demo-session/v1";

export type DemoSession = Readonly<{
  sessionId: string;
  demoInstanceId: string;
  userId: DemoUserId;
  role: DemoRole;
  expiresAt: number;
}>;

export type SignedDemoSession = Readonly<{ token: string; claims: DemoSession }>;

type SessionPayload = { sid: string; did: string; uid: string; r: string; exp: number };

function validText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function canonicalPayload(claims: DemoSession): SessionPayload {
  return {
    sid: claims.sessionId,
    did: claims.demoInstanceId,
    uid: claims.userId,
    r: claims.role,
    exp: claims.expiresAt,
  };
}

function validateClaims(value: unknown): DemoSession | undefined {
  const record = parseOwnDataRecord(value, ["sid", "did", "uid", "r", "exp"]);
  if (!record || !isDemoRole(record.r) || !validText(record.did)) return undefined;
  if (!validText(record.sid, 128) || !decodeCanonicalBase64Url(record.sid)) return undefined;
  if (Buffer.from(record.sid, "base64url").length < 16) return undefined;
  if (record.uid !== DEMO_IDENTITIES[record.r].userId) return undefined;
  if (!Number.isSafeInteger(record.exp) || (record.exp as number) <= 0) return undefined;
  return Object.freeze({
    sessionId: record.sid,
    demoInstanceId: record.did,
    userId: DEMO_IDENTITIES[record.r].userId,
    role: record.r,
    expiresAt: record.exp as number,
  });
}

export function createDemoSessionSigner(options: {
  key?: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}) {
  const key = decodeSigningKey(options.key);
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? secureRandomBytes;

  const mint = (input: {
    demoInstanceId: string;
    role: DemoRole;
    expiresAt: number;
  }): SignedDemoSession => {
    const currentTime = now();
    if (
      !Number.isSafeInteger(currentTime)
      || !validText(input.demoInstanceId)
      || !isDemoRole(input.role)
      || !Number.isSafeInteger(input.expiresAt)
      || input.expiresAt <= currentTime
    ) throw new DomainError("VALIDATION_FAILED");
    const claims = Object.freeze({
      sessionId: encodeBase64Url(randomBytes(24)),
      demoInstanceId: input.demoInstanceId,
      userId: DEMO_IDENTITIES[input.role].userId,
      role: input.role,
      expiresAt: input.expiresAt,
    }) as DemoSession;
    if (!validateClaims(canonicalPayload(claims))) throw new DomainError("CONFIGURATION_ERROR");
    const payload = encodeBase64Url(JSON.stringify(canonicalPayload(claims)));
    const token = `${VERSION}.${payload}.${signSegment(key, PURPOSE, payload)}`;
    if (token.length > MAX_SIGNED_ENVELOPE_LENGTH) throw new DomainError("CONFIGURATION_ERROR");
    return Object.freeze({ token, claims });
  };

  const verify = (token: string | undefined): DemoSession => {
    try {
      if (!token || token.length > MAX_SIGNED_ENVELOPE_LENGTH) throw new Error();
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== VERSION) throw new Error();
      const bytes = decodeCanonicalBase64Url(parts[1]);
      if (!bytes || !signatureMatches(key, PURPOSE, parts[1], parts[2])) throw new Error();
      const record = JSON.parse(bytes.toString("utf8")) as unknown;
      const claims = validateClaims(record);
      if (!claims || encodeBase64Url(JSON.stringify(canonicalPayload(claims))) !== parts[1]) throw new Error();
      if (claims.expiresAt <= now()) throw new Error();
      return claims;
    } catch {
      throw new DomainError("AUTH_REQUIRED");
    }
  };

  return Object.freeze({
    mint,
    verify,
    rotate(claims: DemoSession, role: DemoRole) {
      if (!isDemoRole(role)) throw new DomainError("VALIDATION_FAILED");
      return mint({ demoInstanceId: claims.demoInstanceId, role, expiresAt: claims.expiresAt });
    },
  });
}

export type DemoSessionSigner = ReturnType<typeof createDemoSessionSigner>;

export function buildDemoSessionCookie(input: {
  token: string;
  claims: DemoSession;
  appOrigin: string;
  now: number;
}): string {
  const origin = parseCanonicalAppOrigin(input.appOrigin);
  if (!Number.isSafeInteger(input.now) || input.claims.expiresAt <= input.now) {
    throw new DomainError("VALIDATION_FAILED");
  }
  const maxAge = Math.floor((input.claims.expiresAt - input.now) / 1_000);
  const attributes = [
    `${DEMO_SESSION_COOKIE}=${input.token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    `Expires=${new Date(input.claims.expiresAt).toUTCString()}`,
  ];
  if (origin.protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}
