import { describe, expect, it } from "vitest";
import { DOMAIN_ERROR_CODES, DomainError, type DomainErrorCode } from "./domain-error";

describe("DomainError", () => {
  it("在运行时拒绝闭合集合之外的 code", () => {
    expect(() => new DomainError("INTERNAL_DEBUG" as DomainErrorCode)).toThrow(TypeError);
  });

  it("冻结实例并始终从可信 code 生成安全 JSON", () => {
    const error = new DomainError("FORBIDDEN");

    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isExtensible(error)).toBe(false);
    expect(() => {
      (error as unknown as { code: string }).code = "INTERNAL_DEBUG";
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(error, "requestId", { value: "private-id" })).toThrow(TypeError);
    expect(error.toJSON()).toEqual({
      error: { code: "FORBIDDEN", message: "You are not allowed to perform this action." },
    });
  });

  it("冻结公开闭合代码集合", () => {
    expect(Object.isFrozen(DOMAIN_ERROR_CODES)).toBe(true);
    expect(() => {
      (DOMAIN_ERROR_CODES as unknown as string[]).push("INTERNAL_DEBUG");
    }).toThrow(TypeError);
  });
});
