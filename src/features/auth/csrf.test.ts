import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createCsrfService } from "./csrf";

const KEY = Buffer.alloc(32, 13).toString("base64");
const NOW = Date.UTC(2026, 7, 26, 12);

describe("action-bound CSRF", () => {
  it("token payload 不暴露 sessionId，verify 返回冻结安全元数据和 32-byte digest", () => {
    const csrf = createCsrfService({ key: KEY, now: () => NOW });
    const token = csrf.mint({
      sessionId: "session-a",
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
      expiresAt: NOW + 60_000,
      oneTime: true,
    });
    const payload = Buffer.from(token.split(".")[1], "base64url").toString("utf8");
    const verified = csrf.verify({
      token,
      sessionId: "session-a",
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
    });

    expect(payload).not.toContain("session-a");
    expect(verified).toEqual({
      oneTime: true,
      expiresAt: NOW + 60_000,
      nonceDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(Buffer.from(verified.nonceDigest, "base64url")).toHaveLength(32);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it.each([
    { sessionId: "session-b" },
    { method: "PUT" },
    { routeId: "api.demo.start" },
    { action: "claim_approve" },
  ])("拒绝 wrong-session/method/route/action %#", (override) => {
    const csrf = createCsrfService({ key: KEY, now: () => NOW });
    const input = {
      sessionId: "session-a",
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
    } as const;
    const token = csrf.mint({ ...input, expiresAt: NOW + 60_000, oneTime: true });

    expect(() => csrf.verify({ ...input, ...override, token })).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("拒绝 tamper、expiry、缺失和 oversize，且统一 FORBIDDEN", () => {
    let now = NOW;
    const csrf = createCsrfService({ key: KEY, now: () => now });
    const input = {
      sessionId: "session-a",
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
    } as const;
    const token = csrf.mint({ ...input, expiresAt: NOW + 1_000, oneTime: true });
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    for (const invalid of [undefined, "", "x".repeat(1_025), tampered]) {
      expect(() => csrf.verify({ ...input, token: invalid })).toThrow(
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }
    now = NOW + 1_000;
    expect(() => csrf.verify({ ...input, token })).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it.each([
    undefined,
    "",
    "not-base64",
    Buffer.alloc(31).toString("base64"),
  ])("CSRF key 缺失、弱或畸形统一配置失败 %#", (key) => {
    expect(() => createCsrfService({ key })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });

  it("不同随机 nonce 产生不同 token 与 digest", () => {
    const csrf = createCsrfService({ key: KEY, now: () => NOW });
    const input = {
      sessionId: "session-a",
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
      expiresAt: NOW + 60_000,
      oneTime: true,
    } as const;
    const first = csrf.mint(input);
    const second = csrf.mint(input);

    expect(second).not.toBe(first);
    expect(csrf.verify({ ...input, token: second }).nonceDigest)
      .not.toBe(csrf.verify({ ...input, token: first }).nonceDigest);
  });
});
