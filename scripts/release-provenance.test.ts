import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
let shell = "";
const slash = (value: string) => value.replaceAll("\\", "/");

beforeAll(() => {
  shell = ["sh", "C:/Program Files/Git/bin/sh.exe", "C:/Program Files/Git/usr/bin/sh.exe"]
    .find((item) => spawnSync(item, ["-c", "exit 0"], { windowsHide: true }).status === 0) ?? "";
  if (!shell) throw new Error("POSIX sh required");
});
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function executable(file: string, body: string) {
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
  await chmod(file, 0o755);
}

describe("release provenance preflight", () => {
  it.each(["tracked", "staged", "untracked", "ls-failure"])("fails closed for a %s checkout", async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "claimgate-provenance-"));
    roots.push(root);
    const output = path.join(root, "out");
    await mkdir(output);
    const git = path.join(root, "git");
    const docker = path.join(root, "docker");
    const trace = path.join(root, "trace");
    await executable(git, [
      'if [ "$MODE" = tracked ] && [ "$1 $2" = "diff --quiet" ]; then exit 1; fi',
      'if [ "$MODE" = staged ] && [ "$1 $2 $3" = "diff --cached --quiet" ]; then exit 1; fi',
      'if [ "$MODE" = untracked ] && [ "$1" = ls-files ]; then echo untracked; exit 0; fi',
      'if [ "$MODE" = ls-failure ] && [ "$1" = ls-files ]; then exit 1; fi',
      'if [ "$1" = rev-parse ]; then printf "%040d\\n" 0; fi',
    ].join("\n"));
    await executable(docker, 'echo docker >> "$TRACE"');
    const result = spawnSync(shell, ["scripts/prepare-release-artifacts.sh", slash(output)], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true,
      env: { ...process.env, MODE: mode, TRACE: slash(trace), CLAIMGATE_GIT: slash(git),
        CLAIMGATE_DOCKER: slash(docker) },
    });
    expect(result.status).not.toBe(0);
    await expect(readFile(trace, "utf8")).rejects.toThrow();
  });

  it("fails closed on a stale output lock before invoking Docker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claimgate-lock-"));
    roots.push(root);
    const output = path.join(root, "out");
    await mkdir(path.join(output, ".prepare.lock"), { recursive: true });
    const result = spawnSync(shell, ["scripts/prepare-release-artifacts.sh", slash(output)], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true,
    });
    expect(result.status).not.toBe(0);
    expect(await import("node:fs/promises").then(({ readdir }) => readdir(output)))
      .toEqual([".prepare.lock"]);
  });

  it("does not delete a successor lock after an ABA replacement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claimgate-aba-"));
    roots.push(root);
    const output = path.join(root, "out"); await mkdir(output);
    const git = path.join(root, "git"); const docker = path.join(root, "docker");
    await executable(git, [
      'if [ "$1" = rev-parse ]; then printf "%040d\\n" 0; exit; fi',
      'if [ "$1" = archive ]; then : > "${3#--output=}"; fi',
    ].join("\n"));
    await executable(docker, [
      'rm -rf "$OUTPUT/.prepare.lock"', 'mkdir "$OUTPUT/.prepare.lock"',
      'echo successor > "$OUTPUT/.prepare.lock/owner"', 'kill -TERM "$PPID"',
    ].join("\n"));
    const result = spawnSync(shell, ["scripts/prepare-release-artifacts.sh", slash(output)], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true,
      env: { ...process.env, OUTPUT: slash(output), CLAIMGATE_GIT: slash(git),
        CLAIMGATE_DOCKER: slash(docker), CLAIMGATE_LOCK_TOKEN: "first" },
    });
    expect(result.status).not.toBe(0);
    expect(await readFile(path.join(output, ".prepare.lock/owner"), "utf8")).toBe("successor\n");
  });
});
