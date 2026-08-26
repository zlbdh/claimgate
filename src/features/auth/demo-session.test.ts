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

describe("签名演示会话", () => {
  it("只签发固定身份、随机不透明 sessionId 和实例内绝对到期时间", () => {
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

  it("角色切换只改变固定身份并旋转 sessionId，不延长会话", () => {
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
  ])("弱、缺失或非 canonical key 统一配置失败 %#", (key) => {
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
  ])("缺失或畸形 envelope 统一 AUTH_REQUIRED %#", (token) => {
    const signer = createDemoSessionSigner({ key: KEY, now: () => NOW });
    expect(() => signer.verify(token)).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("拒绝篡改和到期 token，且不透露具体校验阶段", () => {
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

  it("即使签名正确也拒绝 noncanonical key order、额外字段和身份错配", () => {
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

  it("拒绝签发已过期、超出安全整数或非法实例的 claims", () => {
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

describe("演示会话 Cookie", () => {
  it.each([
    ["http://127.0.0.1:3100", false],
    ["https://demo.example.test", true],
  ] as const)("按 APP_ORIGIN 决定 Secure：%s", (appOrigin, secure) => {
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
