import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDemoSessionCookie,
  createDemoSessionSigner,
  DEMO_SESSION_COOKIE,
} from "./demo-session";
import { DEMO_IDENTITIES } from "@/shared/demo-identity";

const KEY = Buffer.alloc(32, 11).toString("base64");
const NOW = Date.UTC(2026, 7, 26, 12);
const EXPIRY = NOW + 2 * 60 * 60 * 1_000;

function signRawPayload(payloadValue: unknown): string {
  const payload = Buffer.from(JSON.stringify(payloadValue), "utf8").toString("base64url");
  const signature = createHmac("sha256", Buffer.from(KEY, "base64"))
    .update(`ClaimGate/demo-session/v1\0${payload}`, "utf8")
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}

describe("Signed demo sessions", () => {
  it("issues only fixed identities, random opaque sessionIds, and absolute expiration within the instance", () => {
    const signer = createDemoSessionSigner({ key: KEY, now: () => NOW });
    const first = signer.mint({
      demoInstanceId: "demo-a",
      role: "CLAIMANT",
      expiresAt: EXPIRY,
    });
    const second = signer.mint({
      demoInstanceId: "demo-a",
      role: "CLAIMANT",
      expiresAt: EXPIRY,
    });

    expect(first.claims).toEqual({
      sessionId: expect.any(String),
      demoInstanceId: "demo-a",
      userId: DEMO_IDENTITIES.CLAIMANT.userId,
      role: "CLAIMANT",
      expiresAt: EXPIRY,
    });
    expect(Buffer.from(first.claims.sessionId, "base64url").length).toBeGreaterThanOrEqual(16);
    expect(second.claims.sessionId).not.toBe(first.claims.sessionId);
    expect(first.token).not.toContain("claimant-demo");
    expect(first.token.length).toBeLessThanOrEqual(1_024);
    expect(signer.verify(first.token)).toEqual(first.claims);
  });

  it("switching roles changes only the fixed identity and rotates sessionId without extending the session", () => {
    const signer = createDemoSessionSigner({ key: KEY, now: () => NOW });
    const claimant = signer.mint({
      demoInstanceId: "demo-a",
      role: "CLAIMANT",
      expiresAt: EXPIRY,
    });
    const staff = signer.rotate(claimant.claims, "STAFF");

    expect(staff.claims).toEqual({
      sessionId: expect.any(String),
      demoInstanceId: claimant.claims.demoInstanceId,
      userId: DEMO_IDENTITIES.STAFF.userId,
      role: "STAFF",
      expiresAt: claimant.claims.expiresAt,
    });
    expect(staff.claims.sessionId).not.toBe(claimant.claims.sessionId);
  });

  it.each([
    undefined,
    "",
    "not-base64",
    Buffer.alloc(31).toString("base64"),
    `${Buffer.alloc(32).toString("base64")}=`,
  ])("weak, missing, or noncanonical keys cause the same configuration failure %#", (key) => {
    expect(() => createDemoSessionSigner({ key })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });

  it.each([
    undefined,
    "",
    "x".repeat(1_025),
    "v1.only-two",
    "v2.e30.signature",
    "v1.***.signature",
  ])("missing or malformed envelopes uniformly return AUTH_REQUIRED %#", (token) => {
    const signer = createDemoSessionSigner({ key: KEY, now: () => NOW });
    expect(() => signer.verify(token)).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("rejects tampered and expired tokens without revealing the validation stage", () => {
    let now = NOW;
    const signer = createDemoSessionSigner({ key: KEY, now: () => now });
    const signed = signer.mint({
      demoInstanceId: "demo-a",
      role: "CLAIMANT",
      expiresAt: NOW + 1_000,
    });
    const parts = signed.token.split(".");
    parts[1] = `${parts[1].slice(0, -1)}${parts[1].endsWith("A") ? "B" : "A"}`;

    expect(() => signer.verify(parts.join("."))).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
    now = NOW + 1_000;
    expect(() => signer.verify(signed.token)).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("rejects noncanonical key order, extra fields, and identity mismatches even with a valid signature", () => {
    const signer = createDemoSessionSigner({ key: KEY, now: () => NOW });
    const sid = Buffer.alloc(24, 1).toString("base64url");
    const invalidPayloads = [
      { did: "demo-a", sid, uid: "claimant-demo", r: "CLAIMANT", exp: EXPIRY },
      { sid, did: "demo-a", uid: "claimant-demo", r: "CLAIMANT", exp: EXPIRY, extra: true },
      { sid, did: "demo-a", uid: "staff-demo", r: "CLAIMANT", exp: EXPIRY },
    ];
    for (const payload of invalidPayloads) {
      expect(() => signer.verify(signRawPayload(payload))).toThrow(
        expect.objectContaining({ code: "AUTH_REQUIRED" }),
      );
    }
  });

  it("rejects expired claims, unsafe integers, and invalid instances", () => {
    const signer = createDemoSessionSigner({ key: KEY, now: () => NOW });
    for (const input of [
      { demoInstanceId: "", role: "CLAIMANT", expiresAt: EXPIRY },
      { demoInstanceId: "demo-a", role: "OWNER", expiresAt: EXPIRY },
      { demoInstanceId: "demo-a", role: "CLAIMANT", expiresAt: NOW },
      { demoInstanceId: "demo-a", role: "CLAIMANT", expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => signer.mint(input as never)).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
  });
});

describe("Demo session cookies", () => {
  it.each([
    ["http://127.0.0.1:3100", false],
    ["https://demo.example.test", true],
  ] as const)("sets Secure according to APP_ORIGIN: %s", (appOrigin, secure) => {
    const signer = createDemoSessionSigner({ key: KEY, now: () => NOW });
    const signed = signer.mint({
      demoInstanceId: "demo-a",
      role: "CLAIMANT",
      expiresAt: EXPIRY,
    });
    const cookie = buildDemoSessionCookie({
      token: signed.token,
      claims: signed.claims,
      appOrigin,
      now: NOW,
    });

    expect(cookie).toContain(`${DEMO_SESSION_COOKIE}=${signed.token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=7200");
    expect(cookie).toContain(`Expires=${new Date(EXPIRY).toUTCString()}`);
    expect(cookie).not.toContain("Domain=");
    expect(cookie.includes("Secure")).toBe(secure);
  });
});
