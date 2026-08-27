import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
const revision = "a".repeat(40);
const slash = (value: string) => value.replaceAll("\\", "/");
let shell = "";
beforeAll(() => {
  shell = ["sh", "C:/Program Files/Git/bin/sh.exe", "C:/Program Files/Git/usr/bin/sh.exe"]
    .find((item) => spawnSync(item, ["-c", "exit 0"], { windowsHide: true }).status === 0) ?? "";
  if (!shell) throw new Error("POSIX sh required");
});
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function executable(file: string, lines: string[]) {
  await writeFile(file, `#!/bin/sh\nset -eu\n${lines.join("\n")}\n`, "utf8");
  await chmod(file, 0o755);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "claimgate-deploy-lock-"));
  roots.push(root);
  const upload = path.join(root, "upload");
  const releaseRoot = path.join(root, "claimgate");
  const lockRoot = path.join(root, "deploy-lock");
  const bin = path.join(root, "bin");
  await mkdir(upload); await mkdir(lockRoot); await mkdir(bin);
  await mkdir(path.join(releaseRoot, "releases"), { recursive: true });
  await mkdir(path.join(releaseRoot, "runtime/releases"), { recursive: true });
  const names = ["claimgate-app-linux-amd64.tar.gz", "node-v22.20.0-linux-x64.tar.gz",
    "validate-release-archive.py", "CLAIMGATE_REVISION"];
  const hash = "0".repeat(64);
  for (const name of names) await writeFile(path.join(upload, name), name === "CLAIMGATE_REVISION" ? revision : "x");
  await writeFile(path.join(upload, "SHA256SUMS.txt"), `${names.map((name) => `${hash}  ${name}`).join("\n")}\n`);
  const trace = path.join(root, "trace"); const barrier = path.join(root, "barrier");
  await writeFile(trace, "");
  await executable(path.join(bin, "stat"), ["for target; do :; done",
    'if [ "$target" = "$ROOT" ] || [ "$target" = "$UPLOAD" ] || [ "$target" = "$LOCK_ROOT" ]; then echo root:root 700; exit; fi',
    'case "$target" in SHA256SUMS.txt|CLAIMGATE_REVISION|*/SHA256SUMS.txt|*/CLAIMGATE_REVISION|*.tar.gz|*.py) echo root:root 600;; *) echo root:root 755;; esac']);
  await executable(path.join(bin, "realpath"), ["for target; do :; done", 'printf "%s\\n" "$target"']);
  await executable(path.join(bin, "sha256sum"), ['if [ "$1" = -c ]; then exit; fi',
    'echo eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29\ \ "$1"']);
  await executable(path.join(bin, "systemd-run"), ["exit 0"]);
  await executable(path.join(bin, "install"), ['last=; before=; for value; do before=$last; last=$value; done', 'mkdir -p "$before" "$last"']);
  await executable(path.join(bin, "tar"), ['echo tar >> "$TRACE"', ': > "$BARRIER"', "sleep 1"]);
  await executable(path.join(bin, "runuser"), ['echo smoke >> "$TRACE"']);
  const args = ["scripts/verify-release-artifacts.sh", slash(upload), revision,
    slash(path.join(releaseRoot, `releases/${revision}`)), slash(path.join(releaseRoot, `runtime/releases/${revision}`))];
  const env = { ...process.env, ROOT: slash(root), UPLOAD: slash(upload), LOCK_ROOT: slash(lockRoot),
    TRACE: slash(trace), BARRIER: slash(barrier), CLAIMGATE_RELEASE_ROOT: slash(releaseRoot),
    CLAIMGATE_UPLOAD_ROOT: slash(root), CLAIMGATE_DEPLOY_LOCK_ROOT: slash(lockRoot),
    CLAIMGATE_STAT: slash(path.join(bin, "stat")), CLAIMGATE_REALPATH: slash(path.join(bin, "realpath")),
    CLAIMGATE_SHA256SUM: slash(path.join(bin, "sha256sum")),
    CLAIMGATE_SYSTEMD_RUN: slash(path.join(bin, "systemd-run")), CLAIMGATE_INSTALL: slash(path.join(bin, "install")),
    CLAIMGATE_TAR: slash(path.join(bin, "tar")), CLAIMGATE_RUNUSER: slash(path.join(bin, "runuser")) };
  return { args, barrier, env, lockRoot, trace };
}

describe("remote deployment transaction lock", () => {
  it("prevents concurrent extraction and releases only the owner's lock", async () => {
    const value = await fixture();
    const first = spawn(shell, value.args, { cwd: process.cwd(), env: value.env, windowsHide: true });
    let stderr = ""; first.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const completion = new Promise<typeof outcome>((resolve) => first.once("exit", (code, signal) => {
      outcome = { code, signal }; resolve(outcome);
    }));
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(value.barrier) && !outcome && Date.now() < deadline) {
        await Promise.race([completion, new Promise((resolve) => setTimeout(resolve, 25))]);
      }
      expect({ barrier: existsSync(value.barrier), outcome, stderr,
        trace: await readFile(value.trace, "utf8") }).toEqual({
        barrier: true, outcome: undefined, stderr: "", trace: "tar\n",
      });
      const second = spawnSync(shell, value.args, { cwd: process.cwd(), env: value.env, windowsHide: true });
      expect(second.status).not.toBe(0);
      expect(await completion).toEqual({ code: 0, signal: null });
      expect((await readFile(value.trace, "utf8")).trim().split("\n")).toEqual(["tar", "tar", "smoke"]);
      expect(existsSync(path.join(value.lockRoot, "active"))).toBe(false);
      const afterCompletion = spawnSync(shell, value.args, { cwd: process.cwd(), env: value.env, windowsHide: true });
      expect(afterCompletion.status).not.toBe(0);
      expect((await readFile(value.trace, "utf8")).trim().split("\n")).toEqual(["tar", "tar", "smoke"]);
    } finally {
      if (!outcome) {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(first.pid), "/T", "/F"]);
        else first.kill("SIGTERM");
        await Promise.race([completion, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        if (!outcome) { first.kill("SIGKILL"); await completion; }
      }
    }
  }, 30_000);

  it("fails closed on a stale lock without reaching extraction", async () => {
    const value = await fixture();
    await mkdir(path.join(value.lockRoot, "active"));
    await writeFile(path.join(value.lockRoot, "active/owner"), "stale");
    expect(spawnSync(shell, value.args, { cwd: process.cwd(), env: value.env }).status).not.toBe(0);
    expect(await readFile(value.trace, "utf8")).toBe("");
  });
});
