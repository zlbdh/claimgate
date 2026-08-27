import { describe, expect, it } from "vitest";
import {
  NATIVE_TOOL_NAMES,
  NATIVE_PHASE_MATRIX,
  createNativeAcceptanceDraft,
  finalizeNativeAcceptance,
  parseNativeAcceptanceResult,
  phaseEvidence,
} from "./native-acceptance-contract";

describe("native acceptance evidence contract", () => {
  it("rejects a partial phase trace even when all nine tools are listed", () => {
    expect(() => createNativeAcceptanceDraft({
      identity: { runId: "11111111-1111-4111-8111-111111111111", ordinal: 1,
        baseCommit: "a".repeat(40), buildId: "build", playwrightVersion: "1.62.1" },
      startedAtMs: Date.now(),
      browserVersion: "151.0.7922.34",
      phases: [phaseEvidence("Home teardown", [], [])],
      executedTools: [...NATIVE_TOOL_NAMES],
      instanceCount: 1,
    })).toThrow(/13-stage phase matrix/i);
  });

  it("requires cleanup, exact identity, nine tools, and final Home teardown", () => {
    const startedAtMs = Date.now() - 10;
    const identity = {
      runId: "11111111-1111-4111-8111-111111111111",
      ordinal: 1,
      baseCommit: "a".repeat(40),
      buildId: "build-1",
      playwrightVersion: "1.62.1",
    };
    const draft = createNativeAcceptanceDraft({
      identity,
      startedAtMs,
      browserVersion: "151.0.7922.34",
      phases: NATIVE_PHASE_MATRIX.map(({ phase, tools }) => phaseEvidence(
        phase,
        tools,
        tools.map((name) => `${name}:JSON-string`),
      )),
      executedTools: [...NATIVE_TOOL_NAMES],
      instanceCount: 1,
    });
    const result = finalizeNativeAcceptance(draft, startedAtMs);
    expect(result).toMatchObject({
      cleanupVerified: true,
      humanOnlyToolsAbsent: true,
      instanceCount: 1,
      executedTools: NATIVE_TOOL_NAMES,
    });
    expect(parseNativeAcceptanceResult(JSON.stringify(result), identity)).toEqual(result);
    expect(() => parseNativeAcceptanceResult(JSON.stringify(result), {
      ...identity,
      buildId: "other-build",
    })).toThrow(/identity mismatch/i);
  });
});
