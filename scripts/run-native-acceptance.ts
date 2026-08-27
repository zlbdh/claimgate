import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  parseNativeAcceptanceResult,
  sha256,
  type NativeAcceptanceResult,
} from "./native-acceptance-contract";
import {
  renderNativeTestingMarkdown,
  type NativeAcceptanceAggregate,
  type NativeRunArtifact,
} from "./native-acceptance-report";
import { publishNativeAcceptanceTransaction } from "./native-acceptance-publisher";
import { removeNativeTemporaryDirectory } from "./native-secret-canary";

const ROOT = process.cwd();
const EVIDENCE_DIR = resolve("docs/submission/evidence/native");
const TESTING_PATH = resolve("docs/submission/testing.md");
const TSX_CLI = resolve("node_modules/tsx/dist/cli.mjs");
const VERIFIER = resolve("scripts/verify-native-webmcp.ts");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function runVerifier(input: {
  ordinal: number;
  runId: string;
  baseCommit: string;
  buildId: string;
}): NativeAcceptanceResult {
  const child = spawnSync(process.execPath, [TSX_CLI, VERIFIER], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLAIMGATE_NATIVE_ORDINAL: String(input.ordinal),
      CLAIMGATE_NATIVE_RUN_ID: input.runId,
      CLAIMGATE_NATIVE_BASE_COMMIT: input.baseCommit,
      CLAIMGATE_NATIVE_BUILD_ID: input.buildId,
    },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (child.status !== 0 || child.error) {
    throw new Error(`Native acceptance run ${input.ordinal} failed`);
  }
  return parseNativeAcceptanceResult(child.stdout, input);
}

function checksumLine(hash: string, path: string): string {
  return `${hash}  ${basename(path)}`;
}

function main(): void {
  const baseCommit = git("rev-parse", "HEAD");
  const sourceState = git("status", "--porcelain").length === 0 ? "clean" : "dirty";
  if (process.argv.includes("--require-clean") && sourceState !== "clean") {
    throw new Error("Clean native acceptance requires a clean worktree");
  }
  const buildId = readFileSync(resolve(".next/BUILD_ID"), "utf8").trim();
  const privateDir = mkdtempSync(join(tmpdir(), "claimgate-native-acceptance-"));
  const results: NativeAcceptanceResult[] = [];
  const artifacts: NativeRunArtifact[] = [];
  try {
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      if (readFileSync(resolve(".next/BUILD_ID"), "utf8").trim() !== buildId) {
        throw new Error("Next build changed during native acceptance");
      }
      const runId = randomUUID();
      const result = runVerifier({ ordinal, runId, baseCommit, buildId });
      const json = `${JSON.stringify(result, null, 2)}\n`;
      const artifact = join(privateDir, `run-${ordinal}.json`);
      writeFileSync(artifact, json, "utf8");
      results.push(result);
      artifacts.push({
        ordinal, runId, startedAt: result.startedAt, endedAt: result.endedAt,
        durationMs: result.durationMs, browserVersion: result.browserVersion,
        artifact: `evidence/native/run-${ordinal}.json`, sha256: sha256(json),
      });
    }
    if (readFileSync(resolve(".next/BUILD_ID"), "utf8").trim() !== buildId) {
      throw new Error("Next build changed after native acceptance");
    }
    const aggregate: NativeAcceptanceAggregate = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      baseCommit,
      buildId,
      sourceState,
      serial: true,
      runCount: 3,
      allPassed: true,
      runs: artifacts,
    };
    const aggregateJson = `${JSON.stringify(aggregate, null, 2)}\n`;
    const aggregatePrivate = join(privateDir, "aggregate.json");
    writeFileSync(aggregatePrivate, aggregateJson, "utf8");
    const sums = [
      ...artifacts.map((item) => checksumLine(item.sha256, item.artifact)),
      checksumLine(sha256(aggregateJson), "aggregate.json"),
    ].join("\n") + "\n";
    const sumsPrivate = join(privateDir, "SHA256SUMS.txt");
    writeFileSync(sumsPrivate, sums, "utf8");
    const testing = renderNativeTestingMarkdown(aggregate, results[0]!);

    publishNativeAcceptanceTransaction({
      transactionRoot: resolve("docs/submission"),
      privateDir,
      evidenceDir: EVIDENCE_DIR,
      testingPath: TESTING_PATH,
      testingMarkdown: testing,
    });
    process.stdout.write(JSON.stringify({
      nativeAcceptance: "PASS", runs: 3, baseCommit, buildId,
      evidenceDirectory: relative(ROOT, EVIDENCE_DIR).replaceAll("\\", "/"),
    }) + "\n");
  } finally {
    removeNativeTemporaryDirectory(privateDir);
  }
}

main();
