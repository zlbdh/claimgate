import { describe, expect, it } from "vitest";
import { DomainError } from "@/shared/domain-error";
import { mapApiError, throwRateLimited } from "./api-error";

describe("唯一 bounded API error mapping", () => {
  it.each([
    ["AUTH_REQUIRED", 401],
    ["FORBIDDEN", 403],
    ["VALIDATION_FAILED", 400],
    ["NOT_FOUND", 404],
    ["STATE_CHANGED", 409],
    ["CONFLICT", 409],
    ["RATE_LIMITED", 429],
    ["CONFIGURATION_ERROR", 500],
  ] as const)("%s 映射固定状态且不泄漏 stack/cause/ID", async (code, status) => {
    const response = mapApiError(new DomainError(code));
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code, message: expect.any(String) },
    });
    expect(text).not.toMatch(/stack|cause|requestId|session|cookie/i);
  });

  it("private retry error 仍输出 RATE_LIMITED 与正整数有界 Retry-After", async () => {
    let caught: unknown;
    try {
      throwRateLimited(61_001);
    } catch (error) {
      caught = error;
    }
    const response = mapApiError(caught);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("62");
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please try again later.",
      },
    });
  });

  it("unknown error 返回 generic 500，不序列化原始内容", async () => {
    const response = mapApiError(Object.assign(new Error("secret failure"), {
      cause: "private-cause",
      requestId: "internal-id",
    }));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error." },
    });
    expect(text).not.toMatch(/secret|private|internal-id|stack|cause/i);
  });
});
