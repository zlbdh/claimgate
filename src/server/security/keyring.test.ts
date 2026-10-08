import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { DomainError } from "@/shared/domain-error";
import { createKeyring, KEY_PURPOSES } from "./keyring";

const FIXED_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

describe("Purpose-separated keyring", () => {
  it("freezes the public purpose set so callers cannot add a fifth purpose", () => {
    expect(Object.isFrozen(KEY_PURPOSES)).toBe(true);
    expect(() => {
      (KEY_PURPOSES as unknown as string[]).push("audit-log");
    }).toThrow(TypeError);
    expect(KEY_PURPOSES).toEqual(["evidence", "pickup-pass", "candidate-handle", "database-key-check"]);
  });

  it("stably derives four distinct 256-bit purpose keys from the same fixed master key", () => {
    const first = createKeyring(FIXED_MASTER_KEY);
    const second = createKeyring(FIXED_MASTER_KEY);
    const keys = KEY_PURPOSES.map((purpose) => first.getKey(purpose));

    expect(keys).toHaveLength(4);
    expect(keys.every((key) => key.length === 32)).toBe(true);
    expect(second.getKey("evidence")).toEqual(first.getKey("evidence"));
    expect(new Set(keys.map((key) => key.toString("hex"))).size).toBe(4);
  });

  it("returns key copies so caller mutations cannot alter later derivations", () => {
    const keyring = createKeyring(FIXED_MASTER_KEY);
    const exposedKey = keyring.getKey("evidence");
    exposedKey.fill(0);

    expect(keyring.getKey("evidence")).not.toEqual(exposedKey);
  });

  it.each([undefined, "not-base64", Buffer.alloc(31, 7).toString("base64")])(
    "rejects missing or noncanonical master keys and keys shorter than 256 bits",
    (masterKey) => {
      expect(() => createKeyring(masterKey)).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    },
  );

  it("configuration errors do not serialize the supplied master key or internal stack", () => {
    const error = new DomainError("CONFIGURATION_ERROR");

    expect(error.toJSON()).toEqual({
      error: { code: "CONFIGURATION_ERROR", message: "The service is not configured correctly." },
    });
    expect(JSON.stringify(error)).not.toContain("stack");
  });
});
