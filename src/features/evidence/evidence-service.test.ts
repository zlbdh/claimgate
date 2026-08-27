import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createEvidenceDigester, EVIDENCE_SLOTS, type EvidenceDigester } from "./evidence-digester";
import { unlockEvidenceLock, verifyEvidence } from "./evidence-service";

const digester = createEvidenceDigester(Buffer.alloc(32, 41));
const answers = Object.freeze({
  unique_mark: "blue star",
  contents_or_accessory: "small cable",
  identifier_suffix: "4821",
});
const storedSlots = EVIDENCE_SLOTS.map((slot, index) => {
  const salt = Buffer.alloc(16, index + 1);
  return {
    slot,
    salt,
    digest: digester.digest({
      demoInstanceId: "instance-a",
      itemId: "item-a",
      slot,
      salt,
      value: answers[slot],
    }),
  };
});

function verify(candidate: unknown, priorFailedAttempts = 0) {
  return verifyEvidence({
    digester,
    demoInstanceId: "instance-a",
    itemId: "item-a",
    storedSlots,
    answers: candidate,
    priorFailedAttempts,
  });
}

describe("封闭三槽 evidence verification", () => {
  it.each([
    [{}, 0, "INSUFFICIENT_EVIDENCE"],
    [{ unique_mark: answers.unique_mark }, 0, "INSUFFICIENT_EVIDENCE"],
    [{ unique_mark: answers.unique_mark, identifier_suffix: "wrong" }, 1, "INSUFFICIENT_EVIDENCE"],
    [{ unique_mark: answers.unique_mark, identifier_suffix: answers.identifier_suffix }, 0, "ELIGIBLE_FOR_REVIEW"],
    [{ ...answers, contents_or_accessory: "wrong" }, 0, "ELIGIBLE_FOR_REVIEW"],
    [answers, 2, "ELIGIBLE_FOR_REVIEW"],
    [{ unique_mark: "wrong", identifier_suffix: "wrong" }, 2, "LOCKED"],
    [answers, 3, "LOCKED"],
  ])("候选=%j，prior=%d 时只返回封闭 outcome %s", (candidate, prior, outcome) => {
    const result = verify(candidate, prior);
    expect(result).toEqual({ outcome });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(["outcome"]);
  });

  it("即使答案缺失或首槽已匹配仍计算全部三槽", () => {
    const calls: string[] = [];
    const instrumented = Object.freeze({
      digest(input) {
        calls.push(input.slot);
        return Buffer.alloc(32, 9);
      },
    } satisfies EvidenceDigester);
    const result = verifyEvidence({
      digester: instrumented,
      demoInstanceId: "instance-a",
      itemId: "item-a",
      storedSlots: EVIDENCE_SLOTS.map((slot) => ({
        slot,
        salt: Buffer.alloc(16, 1),
        digest: Buffer.alloc(32, 9),
      })),
      answers: { unique_mark: "only-one" },
      priorFailedAttempts: 0,
    });
    expect(result).toEqual({ outcome: "INSUFFICIENT_EVIDENCE" });
    expect(calls).toEqual(EVIDENCE_SLOTS);
  });

  it("拒绝答案对象的原型、symbol、extra key、accessor 与非法值且不触发 getter", () => {
    let getterRuns = 0;
    const getter = Object.defineProperty({}, "unique_mark", {
      enumerable: true,
      get() { getterRuns += 1; return answers.unique_mark; },
    });
    const withSymbol = { unique_mark: answers.unique_mark } as Record<PropertyKey, unknown>;
    withSymbol[Symbol("hidden")] = "x";
    for (const candidate of [
      Object.create(null),
      [],
      { extra: "x" },
      withSymbol,
      getter,
      { unique_mark: 42 },
      { unique_mark: "x".repeat(513) },
    ]) {
      expect(() => verify(candidate)).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
    expect(getterRuns).toBe(0);
  });

  it("拒绝重复/缺失槽以及非 BLOB、错误长度 salt/digest", () => {
    const invalidSets = [
      storedSlots.slice(0, 2),
      [storedSlots[0], storedSlots[0], storedSlots[2]],
      storedSlots.map((entry, index) => index === 0 ? { ...entry, salt: Buffer.alloc(15) } : entry),
      storedSlots.map((entry, index) => index === 0 ? { ...entry, digest: Buffer.alloc(31) } : entry),
      storedSlots.map((entry, index) => index === 0 ? { ...entry, salt: "x" as never } : entry),
    ];
    for (const entries of invalidSets) {
      expect(() => verifyEvidence({
        digester,
        demoInstanceId: "instance-a",
        itemId: "item-a",
        storedSlots: entries as never,
        answers,
        priorFailedAttempts: 0,
      })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    }
  });

  it.each([-1, 1.5, 4, Number.NaN])("拒绝非法 prior failed-attempt 计数 %s", (prior) => {
    expect(() => verify(answers, prior)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});

describe("Staff-only 纯解锁规则", () => {
  it("只把 LOCKED 重置成 EVIDENCE_REQUIRED/0，结果冻结", () => {
    const result = unlockEvidenceLock({ role: "STAFF", status: "LOCKED", attempts: 3 });
    expect(result).toEqual({ status: "EVIDENCE_REQUIRED", attempts: 0 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    { role: "CLAIMANT", status: "LOCKED", attempts: 3 },
    { role: "STAFF", status: "EVIDENCE_REQUIRED", attempts: 3 },
    { role: "STAFF", status: "LOCKED", attempts: 4 },
  ])("拒绝非 Staff、非 LOCKED 或越界计数，不引入最大一次政策", (input) => {
    expect(() => unlockEvidenceLock(input as never)).toThrow(
      expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }),
    );
  });
});
