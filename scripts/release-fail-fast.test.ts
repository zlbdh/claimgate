import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const directories: string[] = [];
let shell: string;

beforeAll(() => {
  const candidates = ["C:/Program Files/Git/bin/sh.exe", "C:/Program Files/Git/usr/bin/sh.exe", "sh"];
  shell = candidates.find((candidate) => spawnSync(candidate, ["-c", "exit 0"], {
    windowsHide: true,
  }).status === 0) ?? "";
  if (!shell) throw new Error("POSIX sh is required for release contract tests");
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    force: true, recursive: true,
  })));
});

async function workspace(): Promise<{ root: string; bin: string; trace: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "claimgate-release-contract-"));
  directories.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const trace = path.join(root, "trace.log");
  await writeFile(trace, "", "utf8");
  await stub(bin, "git", [
    'if [ "$1" = rev-parse ]; then printf "%040d\\n" 0; exit 0; fi',
    'if [ "$1" = ls-files ]; then exit 0; fi',
    'if [ "$1" = archive ]; then : > "${3#--output=}"; exit 0; fi',
    'exit 0',
  ]);
  return { root, bin, trace };
}

async function stub(bin: string, name: string, lines: string[]): Promise<void> {
  const target = path.join(bin, name);
  await writeFile(target, `#!/bin/sh\nset -eu\n${lines.join("\n")}\n`, "utf8");
  await chmod(target, 0o755);
}

function run(script: string, args: string[], environment: Record<string, string>, cwd = process.cwd()) {
  return spawnSync(shell, [script, ...args], {
    cwd, encoding: "utf8", windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

const shellPath = (value: string) => value.replaceAll("\\", "/");
const shellSearchPath = (bin: string) => [bin, ...(process.env.PATH ?? "").split(";")]
  .map(shellPath).join(":");
const secureStat = [
  "for target; do :; done",
  'if [ "$target" = "$TEST_ROOT" ] || [ "$target" = "$TEST_UPLOAD" ]; then echo "root:root 700"; exit; fi',
  'case "$target" in SHA256SUMS.txt|CLAIMGATE_REVISION|*/SHA256SUMS.txt|*/CLAIMGATE_REVISION|*.tar.gz|*.py) echo "root:root 600";; *) echo "root:root 755";; esac',
];

async function releaseBaseline(root: string, revision: string) {
  const upload = path.join(root, "upload");
  const releaseRoot = path.join(root, "claimgate");
  const app = path.join(releaseRoot, `releases/${revision}`);
  const runtime = path.join(releaseRoot, `runtime/releases/${revision}`);
  await mkdir(upload);
  await mkdir(path.dirname(app), { recursive: true });
  await mkdir(path.dirname(runtime), { recursive: true });
  const hash = "0".repeat(64);
  const rows = ["claimgate-app-linux-amd64.tar.gz", "node-v22.20.0-linux-x64.tar.gz",
    "validate-release-archive.py", "CLAIMGATE_REVISION"].map((name) => `${hash}  ${name}`);
  for (const name of rows.map((row) => row.slice(66))) {
    await writeFile(path.join(upload, name), name === "CLAIMGATE_REVISION" ? revision : "fixture", "utf8");
  }
  return { app, releaseRoot, rows, runtime, upload };
}

describe("release shell contracts", () => {
  const revision = "0".repeat(40);
  it("does not generate a transfer manifest when fixed Node SHA verification fails", async () => {
    const { root, bin, trace } = await workspace();
    const output = path.join(root, "release-out");
    await mkdir(output);
    await stub(bin, "docker", [
      'echo "docker:$*" >> "$TRACE"',
      'if [ "$1" = build ]; then printf "sha256:%064d\\n" 0 > "$7"; fi',
      'if [ "$1" = run ]; then touch "$OUTPUT/claimgate-app-linux-amd64.tar.gz" "$OUTPUT/validate-release-archive.py"; fi',
    ]);
    await stub(bin, "curl", [
      'echo "curl:$*" >> "$TRACE"',
      'touch "$OUTPUT/node-v22.20.0-linux-x64.tar.gz"',
    ]);
    await stub(bin, "sha256sum", [
      'echo "sha:$*" >> "$TRACE"',
      'if [ "$1" = -c ] && [ "$2" = - ]; then exit 1; fi',
      "printf 'unexpected manifest line\\n'",
    ]);

    const result = run("scripts/prepare-release-artifacts.sh", [shellPath(output)], {
      OUTPUT: shellPath(output), TRACE: shellPath(trace), PATH: shellSearchPath(bin),
      CLAIMGATE_DOCKER: shellPath(path.join(bin, "docker")),
      CLAIMGATE_CURL: shellPath(path.join(bin, "curl")),
      CLAIMGATE_SHA256SUM: shellPath(path.join(bin, "sha256sum")),
      CLAIMGATE_GIT: shellPath(path.join(bin, "git")),
    });

    expect(result.status).not.toBe(0);
    const calls = await readFile(trace, "utf8");
    expect(calls).toContain("sha:");
    expect(calls).not.toContain("unexpected manifest line");
    await expect(readFile(path.join(output, "SHA256SUMS.txt"), "utf8")).rejects.toThrow();
    expect((await readdir(output)).some((name) => name.startsWith(".SHA256SUMS"))).toBe(false);
  }, 15_000);

  it("canonicalizes a relative output path before constructing the Docker bind mount", async () => {
    const { root, bin, trace } = await workspace();
    const output = path.join(root, "release-out");
    await stub(bin, "docker", [
      'echo "docker:$*" >> "$TRACE"',
      'if [ "$1" = build ]; then printf "sha256:%064d\\n" 0 > "$7"; fi',
      'if [ "$1" = run ]; then printf x > "$OUTPUT/claimgate-app-linux-amd64.tar.gz"; printf x > "$OUTPUT/validate-release-archive.py"; fi',
    ]);
    await stub(bin, "curl", ['printf x > "$OUTPUT/node-v22.20.0-linux-x64.tar.gz"']);
    await stub(bin, "sha256sum", [
      'if [ "$1" = -c ]; then exit 0; fi',
      'case "$1" in *node-v22.20.0-linux-x64.tar.gz) printf "eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29 *%s\\n" "$1"; exit 0;; esac',
      'for file in "$@"; do printf "%064d *%s\\n" 0 "$file"; done',
    ]);
    const script = shellPath(path.join(process.cwd(), "scripts/prepare-release-artifacts.sh"));

    const result = run(script, ["release-out"], {
      OUTPUT: shellPath(output), TRACE: shellPath(trace), PATH: shellSearchPath(bin),
      CLAIMGATE_DOCKER: shellPath(path.join(bin, "docker")),
      CLAIMGATE_CURL: shellPath(path.join(bin, "curl")),
      CLAIMGATE_SHA256SUM: shellPath(path.join(bin, "sha256sum")),
      CLAIMGATE_GIT: shellPath(path.join(bin, "git")),
    }, root);

    expect(result.status).toBe(0);
    expect(await readFile(trace, "utf8")).toMatch(/src=\/[^,]*\/release-out/);
    const rows = (await readFile(path.join(output, "SHA256SUMS.txt"), "utf8")).trim().split("\n");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => /^[0-9a-f]{64}  [A-Za-z0-9._-]+$/.test(row))).toBe(true);
    expect(await readdir(output)).not.toContain(".prepare.lock");
    const second = run(script, ["release-out"], {
      OUTPUT: shellPath(output), TRACE: shellPath(trace),
      CLAIMGATE_DOCKER: shellPath(path.join(bin, "docker")),
      CLAIMGATE_CURL: shellPath(path.join(bin, "curl")),
      CLAIMGATE_SHA256SUM: shellPath(path.join(bin, "sha256sum")),
      CLAIMGATE_GIT: shellPath(path.join(bin, "git")),
    }, root);
    expect(second.status).toBe(0);
    expect((await readFile(path.join(output, "SHA256SUMS.txt"), "utf8")).trim().split("\n")).toEqual(rows);
    expect(await readdir(output)).not.toContain(".prepare.lock");
  }, 15_000);

  it.each(["INT", "TERM"])("exits nonzero and cleans partial state on %s", async (signal) => {
    const { root, bin, trace } = await workspace();
    const output = path.join(root, "release-out");
    await mkdir(output);
    await stub(bin, "docker", [
      'echo "docker:$*" >> "$TRACE"',
      'if [ "$1" = build ]; then kill -"$SIGNAL" "$PPID"; sleep 1; fi',
    ]);
    for (const command of ["curl", "sha256sum"]) {
      await stub(bin, command, [`echo "${command}:$*" >> "$TRACE"`]);
    }
    const result = run("scripts/prepare-release-artifacts.sh", [shellPath(output)], {
      OUTPUT: shellPath(output), TRACE: shellPath(trace), SIGNAL: signal,
      CLAIMGATE_DOCKER: shellPath(path.join(bin, "docker")),
      CLAIMGATE_CURL: shellPath(path.join(bin, "curl")),
      CLAIMGATE_SHA256SUM: shellPath(path.join(bin, "sha256sum")),
      CLAIMGATE_GIT: shellPath(path.join(bin, "git")),
    });
    expect(result.status).not.toBe(0);
    expect(await readFile(trace, "utf8")).toMatch(/^docker:build/);
    expect(await readFile(trace, "utf8")).not.toMatch(/curl:|sha:/);
    expect((await readdir(output)).some((name) => name.includes("SHA256SUMS"))).toBe(false);
  });

  it("does not validate or extract when the server-side fixed Node SHA check fails", async () => {
    const { root, bin, trace } = await workspace();
    const upload = path.join(root, "upload");
    const releaseRoot = path.join(root, "claimgate");
    await mkdir(upload);
    await mkdir(path.join(releaseRoot, "releases"), { recursive: true });
    await mkdir(path.join(releaseRoot, "runtime/releases"), { recursive: true });
    for (const file of [
      "SHA256SUMS.txt", "claimgate-app-linux-amd64.tar.gz",
      "node-v22.20.0-linux-x64.tar.gz", "validate-release-archive.py", "CLAIMGATE_REVISION",
    ]) await writeFile(path.join(upload, file), "fixture", "utf8");
    const hash = "0".repeat(64);
    await writeFile(path.join(upload, "SHA256SUMS.txt"), [
      `${hash}  claimgate-app-linux-amd64.tar.gz`,
      `${hash}  node-v22.20.0-linux-x64.tar.gz`,
      `${hash}  validate-release-archive.py`,
      `${hash}  CLAIMGATE_REVISION`,
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(upload, "CLAIMGATE_REVISION"), revision, "utf8");
    await stub(bin, "stat", secureStat);
    await stub(bin, "sha256sum", [
      'echo "sha:$*" >> "$TRACE"',
      'if [ "$1" = -c ] && [ "$2" = - ]; then exit 1; fi',
    ]);
    for (const command of ["systemd-run", "tar", "install"]) {
      await stub(bin, command, [`echo "${command}:$*" >> "$TRACE"`]);
    }

    const result = run("scripts/verify-release-artifacts.sh", [
      shellPath(upload), revision, shellPath(`${releaseRoot}/releases/${revision}`),
      shellPath(`${releaseRoot}/runtime/releases/${revision}`),
    ], {
      CLAIMGATE_RELEASE_ROOT: shellPath(releaseRoot), CLAIMGATE_UPLOAD_ROOT: shellPath(root), TRACE: shellPath(trace),
      CLAIMGATE_DEPLOY_LOCK_ROOT: shellPath(upload),
      TEST_ROOT: shellPath(root), TEST_UPLOAD: shellPath(upload),
      PATH: shellSearchPath(bin),
      CLAIMGATE_STAT: shellPath(path.join(bin, "stat")),
      CLAIMGATE_SHA256SUM: shellPath(path.join(bin, "sha256sum")),
      CLAIMGATE_SYSTEMD_RUN: shellPath(path.join(bin, "systemd-run")),
      CLAIMGATE_TAR: shellPath(path.join(bin, "tar")),
      CLAIMGATE_INSTALL: shellPath(path.join(bin, "install")),
    });

    expect(result.status).not.toBe(0);
    const calls = await readFile(trace, "utf8");
    expect(calls).toContain("sha:node-v22.20.0-linux-x64.tar.gz");
    expect(calls).not.toMatch(/systemd-run|tar:|install:/);
  }, 15_000);

  it("rejects missing, duplicate, extra, path-bearing, backslash, and malformed manifest rows", async () => {
    const hash = "0".repeat(64);
    for (const mutate of [
      (rows: string[]) => rows.slice(0, 3),
      (rows: string[]) => [...rows, rows[0]],
      (rows: string[]) => rows.with(3, `${hash}  extra.txt`),
      (rows: string[]) => rows.with(1, rows[1].replace("node-v", "../node-v")),
      (rows: string[]) => rows.with(1, rows[1].replace("node-v", "dir\\node-v")),
      (rows: string[]) => rows.with(0, `${"g".repeat(64)}  claimgate-app-linux-amd64.tar.gz`),
    ]) {
      const { root, bin, trace } = await workspace();
      const { app, releaseRoot, rows, runtime, upload } = await releaseBaseline(root, revision);
      await writeFile(path.join(upload, "SHA256SUMS.txt"), `${mutate(rows).join("\n")}\n`, "utf8");
      await stub(bin, "stat", secureStat);
      for (const command of ["sha256sum", "systemd-run", "tar", "install"]) {
        await stub(bin, command, [`echo "${command}:$*" >> "$TRACE"`]);
      }
      const result = run("scripts/verify-release-artifacts.sh", [
        shellPath(upload), revision, shellPath(app), shellPath(runtime),
      ], {
        CLAIMGATE_RELEASE_ROOT: shellPath(releaseRoot), CLAIMGATE_UPLOAD_ROOT: shellPath(root), TRACE: shellPath(trace),
        CLAIMGATE_DEPLOY_LOCK_ROOT: shellPath(upload),
        TEST_ROOT: shellPath(root), TEST_UPLOAD: shellPath(upload),
        CLAIMGATE_STAT: shellPath(path.join(bin, "stat")),
        CLAIMGATE_SHA256SUM: shellPath(path.join(bin, "sha256sum")),
        CLAIMGATE_SYSTEMD_RUN: shellPath(path.join(bin, "systemd-run")),
        CLAIMGATE_TAR: shellPath(path.join(bin, "tar")),
        CLAIMGATE_INSTALL: shellPath(path.join(bin, "install")),
      });
      expect(result.status).not.toBe(0);
      expect(await readFile(trace, "utf8")).toBe("");
    }
  }, 20_000);

  it("rejects a pre-existing app target before SHA, validation, install, or extraction", async () => {
    const { root, bin, trace } = await workspace();
    const { app, releaseRoot, rows, runtime, upload } = await releaseBaseline(root, revision);
    await writeFile(path.join(upload, "SHA256SUMS.txt"), `${rows.join("\n")}\n`, "utf8");
    await mkdir(app);
    await stub(bin, "stat", secureStat);
    for (const command of ["sha256sum", "systemd-run", "tar", "install"]) {
      await stub(bin, command, [`echo "${command}:$*" >> "$TRACE"`]);
    }
    const result = run("scripts/verify-release-artifacts.sh", [
      shellPath(upload), revision, shellPath(app), shellPath(runtime),
    ], {
      CLAIMGATE_RELEASE_ROOT: shellPath(releaseRoot), CLAIMGATE_UPLOAD_ROOT: shellPath(root), TRACE: shellPath(trace),
      CLAIMGATE_DEPLOY_LOCK_ROOT: shellPath(upload),
      TEST_ROOT: shellPath(root), TEST_UPLOAD: shellPath(upload),
      CLAIMGATE_STAT: shellPath(path.join(bin, "stat")),
      CLAIMGATE_SHA256SUM: shellPath(path.join(bin, "sha256sum")),
      CLAIMGATE_SYSTEMD_RUN: shellPath(path.join(bin, "systemd-run")),
      CLAIMGATE_TAR: shellPath(path.join(bin, "tar")),
      CLAIMGATE_INSTALL: shellPath(path.join(bin, "install")),
    });
    expect(result.status).not.toBe(0);
    expect(await readFile(trace, "utf8")).toBe("");
  });
});
