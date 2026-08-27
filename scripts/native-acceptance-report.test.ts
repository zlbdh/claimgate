import { describe, expect, it } from "vitest";
import {
  NATIVE_TOOL_NAMES,
  NATIVE_PHASE_MATRIX,
  createNativeAcceptanceDraft,
  finalizeNativeAcceptance,
  phaseEvidence,
} from "./native-acceptance-contract";
import { renderNativeTestingMarkdown } from "./native-acceptance-report";

describe("native acceptance Markdown evidence", () => {
  it("labels dirty evidence and links all three hashed run artifacts", () => {
    const startedAtMs = Date.now() - 1;
    const result = finalizeNativeAcceptance(createNativeAcceptanceDraft({
      identity: { runId: "11111111-1111-4111-8111-111111111111", ordinal: 1,
        baseCommit: "a".repeat(40), buildId: "build", playwrightVersion: "1.62.1" },
      startedAtMs,
      browserVersion: "151.0.7922.34",
      phases: NATIVE_PHASE_MATRIX.map(({ phase, tools }) => phaseEvidence(
        phase,
        tools,
        tools.map((name) => `${name}:JSON-string`),
      )),
      executedTools: [...NATIVE_TOOL_NAMES],
      instanceCount: 1,
    }), startedAtMs);
    const markdown = renderNativeTestingMarkdown({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      baseCommit: result.baseCommit,
      buildId: result.buildId,
      sourceState: "dirty",
      serial: true,
      runCount: 3,
      allPassed: true,
      runs: [1, 2, 3].map((ordinal) => ({
        ordinal, runId: result.runId, startedAt: result.startedAt,
        endedAt: result.endedAt, durationMs: result.durationMs,
        browserVersion: result.browserVersion,
        artifact: `evidence/native/run-${ordinal}.json`, sha256: "b".repeat(64),
      })),
    }, result);
    expect(markdown).toContain("开发期证据");
    expect(markdown).toContain("accept:native:3:clean");
    for (const ordinal of [1, 2, 3]) expect(markdown).toContain(`run-${ordinal}.json`);
  });
});
