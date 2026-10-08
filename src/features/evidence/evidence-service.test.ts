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

describe("Closed three-slot evidence verification", () => {
  it.each([
    [{}, 0, "INSUFFICIENT_EVIDENCE"],
    [{ unique_mark: answers.unique_mark }, 0, "INSUFFICIENT_EVIDENCE"],
    [{ unique_mark: answers.unique_mark, identifier_suffix: "wrong" }, 1, "INSUFFICIENT_EVIDENCE"],
    [{ unique_mark: answers.unique_mark, identifier_suffix: answers.identifier_suffix }, 0, "ELIGIBLE_FOR_REVIEW"],
    [{ ...answers, contents_or_accessory: "wrong" }, 0, "ELIGIBLE_FOR_REVIEW"],
    [answers, 2, "ELIGIBLE_FOR_REVIEW"],
    [{ unique_mark: "wrong", identifier_suffix: "wrong" }, 2, "LOCKED"],
    [answers, 3, "LOCKED"],
  ])("candidate=%j and prior=%d return only the closed outcome %s", (candidate, prior, outcome) => {
    const result = verify(candidate, prior);
    expect(result).toEqual({ outcome });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(["outcome"]);
  });

  it("computes all three slots even when answers are missing or the first slot already matches", () => {
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

  it("rejects answer-object prototypes, symbols, extra keys, accessors, and invalid values without invoking getters", () => {
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

  it("rejects duplicate or missing slots, non-BLOB values, and incorrect salt/digest lengths", () => {
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

  it.each([-1, 1.5, 4, Number.NaN])("rejects invalid prior failed-attempt counts %s", (prior) => {
    expect(() => verify(answers, prior)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});

describe("Pure Staff-only unlock rules", () => {
  it("resets only LOCKED to EVIDENCE_REQUIRED/0 and freezes the result", () => {
    const result = unlockEvidenceLock({ role: "STAFF", status: "LOCKED", attempts: 3 });
    expect(result).toEqual({ status: "EVIDENCE_REQUIRED", attempts: 0 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    { role: "CLAIMANT", status: "LOCKED", attempts: 3 },
    { role: "STAFF", status: "EVIDENCE_REQUIRED", attempts: 3 },
    { role: "STAFF", status: "LOCKED", attempts: 4 },
  ])("rejects non-Staff, non-LOCKED, and out-of-range counts without adding a one-unlock policy", (input) => {
    expect(() => unlockEvidenceLock(input as never)).toThrow(
      expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }),
    );
  });
});
