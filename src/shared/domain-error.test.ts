import { describe, expect, it } from "vitest";
import { DOMAIN_ERROR_CODES, DomainError, type DomainErrorCode } from "./domain-error";

describe("DomainError", () => {
  it("rejects codes outside the closed set at runtime", () => {
    expect(() => new DomainError("INTERNAL_DEBUG" as DomainErrorCode)).toThrow(TypeError);
  });

  it("freezes instances and always builds safe JSON from trusted codes", () => {
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

  it("freezes the public closed code set", () => {
    expect(Object.isFrozen(DOMAIN_ERROR_CODES)).toBe(true);
    expect(() => {
      (DOMAIN_ERROR_CODES as unknown as string[]).push("INTERNAL_DEBUG");
    }).toThrow(TypeError);
  });
});
