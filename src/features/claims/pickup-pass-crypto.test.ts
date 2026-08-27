import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ADVERSARIAL_BUFFER_KINDS, adversarialBuffer } from "@/test/adversarial-buffer";
import { createPickupPassCrypto, parsePickupPassToken } from "./pickup-pass-crypto";

const KEY = Buffer.alloc(32, 7);
const BASE = Object.freeze({
  demoInstanceId: "demo-pickup",
  claimId: "claim-pickup",
  generation: 1,
  expiresAtMs: 1_800_000_000_000,
});

function lp(value: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(value.length);
  return Buffer.concat([size, value]);
}

function u64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

describe("pickup pass crypto", () => {
  it("generates exactly 16 random bytes and a canonical 22 character token", () => {
    const random = vi.fn((size: number) => Buffer.alloc(size, 0xff));
    const issued = createPickupPassCrypto(KEY, { randomBytes: random }).issue(BASE);

    expect(random.mock.calls).toEqual([[16], [32]]);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(issued.token).toBe("_____________________w");
    expect(issued.salt).toEqual(Buffer.alloc(32, 0xff));
    expect(issued.digest).toHaveLength(32);
  });

  it("rejects aliases, padding and non-canonical last sextets before digest work", () => {
    const canonical = Buffer.alloc(16, 0).toString("base64url");
    expect(parsePickupPassToken(canonical)).toEqual(Buffer.alloc(16, 0));
    for (const token of [
      `${canonical}=`,
      canonical.slice(0, -1),
      `${canonical.slice(0, -1)}B`,
      `${canonical.slice(0, -1)}-`,
      ` ${canonical}`,
    ]) {
      expect(() => parsePickupPassToken(token)).toThrow(expect.objectContaining({
        code: "VALIDATION_FAILED",
      }));
    }
  });

  it("uses uint32BE length-prefixed fields and binds every field", () => {
    const tokenBytes = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const salt = Buffer.alloc(32, 9);
    const crypto = createPickupPassCrypto(KEY, {
      randomBytes: (size) => size === 16 ? tokenBytes : salt,
    });
    const issued = crypto.issue(BASE);
    const expected = createHmac("sha256", KEY).update(Buffer.concat([
      lp(Buffer.from("ClaimGate/pickup-pass/v1")),
      lp(salt),
      lp(Buffer.from(BASE.demoInstanceId)),
      lp(Buffer.from(BASE.claimId)),
      lp(u64(BASE.generation)),
      lp(u64(BASE.expiresAtMs)),
      lp(tokenBytes),
    ])).digest();
    expect(issued.digest).toEqual(expected);

    const variants = [
      { ...BASE, demoInstanceId: "demo-other" },
      { ...BASE, claimId: "claim-other" },
      { ...BASE, generation: 2 },
      { ...BASE, expiresAtMs: BASE.expiresAtMs + 1 },
    ];
    for (const binding of variants) {
      expect(crypto.digest({ ...binding, salt, tokenBytes })).not.toEqual(issued.digest);
    }
    expect(crypto.digest({ ...BASE, salt, tokenBytes: Buffer.alloc(16, 1) }))
      .not.toEqual(issued.digest);
  });

  it("uses the observable fixed-length comparator path", () => {
    const compare = vi.fn((left: Buffer, right: Buffer) => left.length === right.length);
    const crypto = createPickupPassCrypto(KEY, {
      compareDigests: compare,
      randomBytes: (size) => Buffer.alloc(size, size),
    });
    const issued = crypto.issue(BASE);

    expect(crypto.verify({ ...BASE, salt: issued.salt, digest: issued.digest, token: issued.token }))
      .toBe(true);
    expect(compare).toHaveBeenCalledOnce();
    expect(compare.mock.calls[0]![0]).toHaveLength(32);
    expect(compare.mock.calls[0]![1]).toHaveLength(32);
    expect(() => crypto.verify({
      ...BASE, salt: issued.salt, digest: Buffer.alloc(31), token: issued.token,
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(compare).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid expiry, generation and random source output", () => {
    const crypto = createPickupPassCrypto(KEY, { randomBytes: (size) => Buffer.alloc(size) });
    for (const binding of [
      { ...BASE, generation: 0 },
      { ...BASE, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...BASE, expiresAtMs: 0 },
      { ...BASE, expiresAtMs: 1.5 },
    ]) expect(() => crypto.issue(binding)).toThrow();

    expect(() => createPickupPassCrypto(KEY, {
      randomBytes: (size) => Buffer.alloc(size - 1),
    }).issue(BASE)).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(() => createPickupPassCrypto(Buffer.alloc(31), {
      randomBytes: (size) => Buffer.alloc(size),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it.each(ADVERSARIAL_BUFFER_KINDS)("rejects non-standard %s buffers", (kind) => {
    const counter = { count: 0 };
    const bad = adversarialBuffer(kind, 32, counter);
    expect(() => createPickupPassCrypto(KEY, {
      randomBytes: (size) => size === 16 ? Buffer.alloc(16) : bad,
    }).issue(BASE)).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(counter.count).toBe(0);
  });
});
