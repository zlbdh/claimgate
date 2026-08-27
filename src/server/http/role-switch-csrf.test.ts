import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createCsrfService } from "@/features/auth/csrf";
import { mintRoleSwitchCsrf } from "./role-switch-csrf";

const NOW = Date.UTC(2026, 7, 28, 8);
const csrf = createCsrfService({
  key: Buffer.alloc(32, 73).toString("base64"),
  now: () => NOW,
});
describe("shared role-switch CSRF", () => {
  it.each([
    { sessionExpiresAt: NOW + 60_000, expectedExpiresAt: NOW + 60_000 },
    { sessionExpiresAt: NOW + 60 * 60_000, expectedExpiresAt: NOW + 10 * 60_000 },
  ])("binds the one-time token and caps it at the earlier expiry %#", ({
    sessionExpiresAt,
    expectedExpiresAt,
  }) => {
    const token = mintRoleSwitchCsrf({
      runtime: { csrf, now: () => NOW },
      session: { sessionId: "session-role-resume", expiresAt: sessionExpiresAt },
    });

    expect(csrf.verify({
      token,
      sessionId: "session-role-resume",
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
    })).toMatchObject({ oneTime: true, expiresAt: expectedExpiresAt });
    expect(() => csrf.verify({
      token,
      sessionId: "another-session",
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
