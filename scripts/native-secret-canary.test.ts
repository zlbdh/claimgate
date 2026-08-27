import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeEvidence } from "../src/features/evidence/normalize-evidence";
import {
  cleanupNativeRun,
  forbidRuntimeSecrets,
  stopNativeServer,
} from "./native-secret-canary";

describe("native runtime secret surface scanner", () => {
  it("rejects both raw and normalized evidence canaries", () => {
    const evidence = "CG10EvidenceMixedCASE123";
    expect(() => forbidRuntimeSecrets(evidence, [evidence], evidence)).toThrow();
    expect(() => forbidRuntimeSecrets(
      normalizeEvidence(evidence),
      [evidence],
      evidence,
    )).toThrow();
    expect(() => forbidRuntimeSecrets("safe surface", [evidence], evidence)).not.toThrow();
  });

  it("stops the server and removes the temp directory even when browser close rejects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claimgate-native-cleanup-test-"));
    let exitCode: number | null = null;
    const emitter = new EventEmitter();
    const server = Object.assign(emitter, {
      get exitCode() { return exitCode; },
      kill() {
        exitCode = 0;
        queueMicrotask(() => emitter.emit("exit", 0));
        return true;
      },
    }) as unknown as ChildProcess;
    const browser = { close: async () => { throw new Error("browser close failed"); } };

    await expect(cleanupNativeRun(browser, server, directory, 10)).rejects.toThrow(
      /browser close failed/,
    );
    expect(exitCode).toBe(0);
    expect(existsSync(directory)).toBe(false);
  });

  it("fails instead of claiming cleanup when a child refuses both termination attempts", async () => {
    const emitter = new EventEmitter();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const server = Object.assign(emitter, {
      get exitCode() { return null; },
      kill(signal?: NodeJS.Signals | number) { signals.push(signal); return true; },
    }) as unknown as ChildProcess;

    await expect(stopNativeServer(server, 1)).rejects.toThrow(/did not exit/);
    expect(signals).toEqual([undefined, "SIGKILL"]);
  });
});
