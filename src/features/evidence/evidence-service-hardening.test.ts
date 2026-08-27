import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADVERSARIAL_BUFFER_KINDS,
  adversarialBuffer,
} from "@/test/adversarial-buffer";

import {
  createEvidenceDigester,
  EVIDENCE_SLOTS,
  type EvidenceDigester,
  type EvidenceSlot,
} from "./evidence-digester";
import { createEvidenceVerifier, unlockEvidenceLock } from "./evidence-service";

const realDigester = createEvidenceDigester(Buffer.alloc(32, 51));
const expectedAnswers = Object.freeze({
  unique_mark: "first mark",
  contents_or_accessory: "second accessory",
  identifier_suffix: "zx-3141",
});
const storedSlots = EVIDENCE_SLOTS.map((slot, index) => {
  const salt = Buffer.alloc(16, index + 11);
  return {
    slot,
    salt,
    digest: realDigester.digest({
      demoInstanceId: "instance-hardening",
      itemId: "item-hardening",
      slot,
      salt,
      value: expectedAnswers[slot],
    }),
  };
});
const compareCalls: Array<[Buffer, Buffer]> = [];
const instrumentedVerifier = createEvidenceVerifier(Object.freeze({
  equal(left: Buffer, right: Buffer): boolean {
    compareCalls.push([Buffer.from(left), Buffer.from(right)]);
    return timingSafeEqual(left, right);
  },
}));

afterEach(() => {
  compareCalls.length = 0;
});

function verifyWith(options: {
  answers?: unknown;
  slots?: unknown;
  digester?: EvidenceDigester;
  prior?: number;
} = {}) {
  return instrumentedVerifier({
    digester: options.digester ?? realDigester,
    demoInstanceId: "instance-hardening",
    itemId: "item-hardening",
    storedSlots: (options.slots ?? storedSlots) as never,
    answers: options.answers ?? {},
    priorFailedAttempts: options.prior ?? 0,
  });
}

describe("active attempt 固定三槽比较", () => {
  it.each([
    {},
    { unique_mark: expectedAnswers.unique_mark },
    { unique_mark: "wrong", contents_or_accessory: expectedAnswers.contents_or_accessory },
    expectedAnswers,
    { ...expectedAnswers, unique_mark: "wrong" },
  ])("答案矩阵 %j 始终 digest=3/compare=3", (answers) => {
    const digestCalls: EvidenceSlot[] = [];
    const recording = Object.freeze({
      digest(input) {
        digestCalls.push(input.slot);
        return realDigester.digest(input);
      },
    } satisfies EvidenceDigester);
    verifyWith({ answers, digester: recording });
    expect(digestCalls).toEqual(EVIDENCE_SLOTS);
    expect(compareCalls).toHaveLength(3);
    expect(compareCalls.every(([left, right]) => left.length === 32 && right.length === 32)).toBe(true);
  });

  it("任一 digester 输出损坏时仍计算三槽，并在任何 native compare 前安全失败", () => {
    const digestCalls: EvidenceSlot[] = [];
    const malformed = Object.freeze({
      digest(input) {
        digestCalls.push(input.slot);
        return input.slot === "contents_or_accessory" ? Buffer.alloc(31) : Buffer.alloc(32);
      },
    } satisfies EvidenceDigester);
    expect(() => verifyWith({ answers: expectedAnswers, digester: malformed })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect(digestCalls).toEqual(EVIDENCE_SLOTS);
    expect(compareCalls).toHaveLength(0);
  });
});

describe("descriptor-first containers", () => {
  it("答案 Map 不触发 Object.prototype 继承 setter/getter", () => {
    let setterRuns = 0;
    let getterRuns = 0;
    Object.defineProperty(Object.prototype, "unique_mark", {
      configurable: true,
      get() { getterRuns += 1; return "inherited"; },
      set() { setterRuns += 1; },
    });
    try {
      expect(verifyWith({ answers: { unique_mark: expectedAnswers.unique_mark } }))
        .toEqual({ outcome: "INSUFFICIENT_EVIDENCE" });
      expect(setterRuns).toBe(0);
      expect(getterRuns).toBe(0);
    } finally {
      delete (Object.prototype as Record<string, unknown>).unique_mark;
    }
  });

  it("答案拒绝 accessor、symbol、extra、non-enumerable、null prototype 且零调用", () => {
    let invocations = 0;
    const accessor = Object.defineProperty({}, "unique_mark", {
      enumerable: true,
      get() { invocations += 1; return expectedAnswers.unique_mark; },
    });
    const toJson = Object.defineProperty({ unique_mark: expectedAnswers.unique_mark }, "toJSON", {
      enumerable: true,
      get() { invocations += 1; return () => "leak"; },
    });
    const nonEnumerable = Object.defineProperty({}, "unique_mark", {
      enumerable: false,
      value: expectedAnswers.unique_mark,
    });
    const symbol = { unique_mark: expectedAnswers.unique_mark } as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = "x";
    for (const answers of [accessor, toJson, nonEnumerable, symbol, Object.create(null)]) {
      expect(() => verifyWith({ answers })).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
    expect(invocations).toBe(0);
  });

  it("stored Array 在读取前拒绝 iterator/index accessor、extra/symbol/custom prototype", () => {
    let invocations = 0;
    const iterator = [...storedSlots];
    Object.defineProperty(iterator, Symbol.iterator, {
      configurable: true,
      get() { invocations += 1; return Array.prototype[Symbol.iterator]; },
    });
    const indexAccessor = [...storedSlots];
    Object.defineProperty(indexAccessor, "0", {
      configurable: true,
      enumerable: true,
      get() { invocations += 1; return storedSlots[0]; },
    });
    const extra = Object.assign([...storedSlots], { extra: "x" });
    const symbol = [...storedSlots] as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol("extra")] = "x";
    const customPrototype = [...storedSlots];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    for (const slots of [iterator, indexAccessor, extra, symbol, customPrototype]) {
      expect(() => verifyWith({ slots })).toThrow(
        expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
      );
    }
    expect(invocations).toBe(0);
  });

  it("stored entry 在读取前拒绝 getter/prototype/symbol/extra/non-enumerable", () => {
    let invocations = 0;
    const getter = Object.defineProperties({}, {
      slot: { enumerable: true, get() { invocations += 1; return storedSlots[0]!.slot; } },
      salt: { enumerable: true, value: storedSlots[0]!.salt },
      digest: { enumerable: true, value: storedSlots[0]!.digest },
    });
    const inherited = Object.create(Object.defineProperty({}, "slot", {
      get() { invocations += 1; return storedSlots[0]!.slot; },
    }));
    Object.assign(inherited, { salt: storedSlots[0]!.salt, digest: storedSlots[0]!.digest });
    const extra = Object.defineProperty({ ...storedSlots[0] }, "toJSON", {
      enumerable: true,
      get() { invocations += 1; return () => "leak"; },
    });
    const symbol = { ...storedSlots[0] } as Record<PropertyKey, unknown>;
    symbol[Symbol("extra")] = "x";
    const nonEnumerable = Object.defineProperty({
      slot: storedSlots[0]!.slot,
      salt: storedSlots[0]!.salt,
    }, "digest", { enumerable: false, value: storedSlots[0]!.digest });
    for (const entry of [getter, inherited, extra, symbol, nonEnumerable]) {
      expect(() => verifyWith({ slots: [entry, storedSlots[1], storedSlots[2]] })).toThrow(
        expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
      );
    }
    expect(invocations).toBe(0);
  });

  it.each(ADVERSARIAL_BUFFER_KINDS)("stored salt/digest 拒绝 %s Buffer 且零陷阱", (kind) => {
    for (const field of ["salt", "digest"] as const) {
      const counter = { count: 0 };
      const malicious = adversarialBuffer(kind, field === "salt" ? 16 : 32, counter);
      const entry = { ...storedSlots[0], [field]: malicious };
      expect(() => verifyWith({ slots: [entry, storedSlots[1], storedSlots[2]] })).toThrow(
        expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
      );
      expect(counter.count).toBe(0);
      expect(compareCalls).toHaveLength(0);
    }
  });

  it.each(ADVERSARIAL_BUFFER_KINDS)("computed digest 拒绝 %s Buffer 且零陷阱", (kind) => {
    const counter = { count: 0 };
    const digester = Object.freeze({
      digest: () => adversarialBuffer(kind, 32, counter),
    }) satisfies EvidenceDigester;
    expect(() => verifyWith({ answers: expectedAnswers, digester })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect(counter.count).toBe(0);
    expect(compareCalls).toHaveLength(0);
  });

  it("stored/computed Uint8Array 均有界拒绝", () => {
    const entry = { ...storedSlots[0], salt: new Uint8Array(16) };
    expect(() => verifyWith({ slots: [entry, storedSlots[1], storedSlots[2]] })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    const digester = Object.freeze({ digest: () => new Uint8Array(32) as never });
    expect(() => verifyWith({ answers: expectedAnswers, digester })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });

  it("比较器只接收 stored/computed 的 fresh standard clone", () => {
    const computedSource = Buffer.alloc(32, 71);
    const storedSources = EVIDENCE_SLOTS.map((slot, index) => ({
      slot,
      salt: Buffer.alloc(16, index + 1),
      digest: Buffer.alloc(32, 72 + index),
    }));
    const received: Buffer[] = [];
    const verifier = createEvidenceVerifier(Object.freeze({
      equal(left: Buffer, right: Buffer) {
        received.push(left, right);
        left.fill(0);
        right.fill(0);
        return false;
      },
    }));
    verifier({
      digester: Object.freeze({ digest: () => computedSource }),
      demoInstanceId: "instance-hardening",
      itemId: "item-hardening",
      storedSlots: storedSources,
      answers: {},
      priorFailedAttempts: 0,
    });
    expect(computedSource).toEqual(Buffer.alloc(32, 71));
    expect(storedSources.map(({ digest }) => digest[0])).toEqual([72, 73, 74]);
    expect(new Set(received).size).toBe(6);
    expect(received.every((value) => Object.getPrototypeOf(value) === Buffer.prototype)).toBe(true);
  });
});

describe("lock semantics", () => {
  it("prior=3 在 capability/context/count 后直接 LOCKED，不解析容器或 hash", () => {
    let invocations = 0;
    const maliciousSlots = new Array(3);
    Object.defineProperty(maliciousSlots, Symbol.iterator, {
      get() { invocations += 1; throw new Error("must not run"); },
    });
    const maliciousAnswers = Object.defineProperty({}, "unique_mark", {
      enumerable: true,
      get() { invocations += 1; throw new Error("must not run"); },
    });
    const lockedDigester = Object.freeze({
      digest() { invocations += 1; throw new Error("must not run"); },
    } satisfies EvidenceDigester);
    expect(verifyWith({
      answers: maliciousAnswers,
      slots: maliciousSlots,
      digester: lockedDigester,
      prior: 3,
    })).toEqual({ outcome: "LOCKED" });
    expect(invocations).toBe(0);
    expect(compareCalls).toHaveLength(0);
  });

  it.each([0, 1, 2, 4])("unlock 拒绝 LOCKED attempts=%d", (attempts) => {
    expect(() => unlockEvidenceLock({ role: "STAFF", status: "LOCKED", attempts }))
      .toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
  });
});
