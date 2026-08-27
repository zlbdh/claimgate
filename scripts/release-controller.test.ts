import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const directories: string[] = [];
let shell: string;

beforeAll(() => {
  shell = ["C:/Program Files/Git/bin/sh.exe", "C:/Program Files/Git/usr/bin/sh.exe", "sh"]
    .find((candidate) => spawnSync(candidate, ["-c", "exit 0"], { windowsHide: true }).status === 0) ?? "";
  if (!shell) throw new Error("POSIX sh is required for release controller tests");
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    force: true, recursive: true,
  })));
});

const shellPath = (value: string) => value.replaceAll("\\", "/");

async function harness(revision = "a".repeat(40)) {
  const root = await mkdtemp(path.join(tmpdir(), "claimgate-controller-"));
  directories.push(root);
  const ssh = path.join(root, "ssh");
  const trace = path.join(root, "trace");
  const stdin = path.join(root, "stdin");
  const git = path.join(root, "git");
  const artifacts = path.join(root, "artifacts");
  await mkdir(artifacts);
  await writeFile(path.join(artifacts, "CLAIMGATE_REVISION"), revision, "utf8");
  await writeFile(git, ["#!/bin/sh", "set -eu", `case "$*" in *rev-parse*) echo ${revision};; esac`, ""].join("\n"), "utf8");
  await chmod(git, 0o755);
  await writeFile(ssh, ["#!/bin/sh", "set -eu", 'printf "%s\\n" "$*" >> "$TRACE"',
    'cat > "$STDIN_COPY"', ""].join("\n"), "utf8");
  await chmod(ssh, 0o755);
  return { ssh: shellPath(ssh), git: shellPath(git), trace, stdin, artifacts: shellPath(artifacts) };
}

function run(args: string[], values: { ssh: string; git: string; trace: string; stdin: string; artifacts: string }) {
  return spawnSync(shell, ["scripts/deploy-release-over-ssh.sh", ...args], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true,
    env: { ...process.env, CLAIMGATE_SSH: values.ssh, CLAIMGATE_GIT: values.git,
      CLAIMGATE_ARTIFACT_DIR: values.artifacts,
      TRACE: shellPath(values.trace), STDIN_COPY: shellPath(values.stdin) },
  });
}

describe("local SSH release controller", () => {
  const revision = "a".repeat(40);
  it.each([".", "..", "a".repeat(39), "a".repeat(41), "bad id", "bad;id", "bad\nid", "$(touch injected)"])(
    "rejects unsafe release id %j without invoking ssh", async (releaseId) => {
      const values = await harness();
      const result = releaseId.includes("\n")
        ? spawnSync(shell, ["-c", `scripts/deploy-release-over-ssh.sh deploy.example 22000 deployer 'bad\nid'`], {
          cwd: process.cwd(), encoding: "utf8", windowsHide: true,
          env: { ...process.env, CLAIMGATE_SSH: values.ssh,
            TRACE: shellPath(values.trace), STDIN_COPY: shellPath(values.stdin),
            CLAIMGATE_ARTIFACT_DIR: values.artifacts, CLAIMGATE_GIT: values.git },
        })
        : run(["deploy.example", "22000", "deployer", releaseId], values);
      expect(result.status).not.toBe(0);
      await expect(readFile(values.trace, "utf8")).rejects.toThrow();
    },
  );

  it.each([
    ["bad host", "22000"], ["host;name", "22000"], ["-option", "22000"],
    ["deploy.example", "22;id"], ["deploy.example", "0"], ["deploy.example", "70000"],
  ])("rejects unsafe host/port %j:%j without invoking ssh", async (host, port) => {
    const values = await harness();
    const result = run([host, port, "deployer", revision], values);
    expect(result.status).not.toBe(0);
    await expect(readFile(values.trace, "utf8")).rejects.toThrow();
  });

  it.each(["", "-root", "Bad", "bad user", "bad;user", "bad\nuser", "$(touch x)", "a".repeat(33)])(
    "rejects unsafe deployment user %j without invoking ssh", async (user) => {
      const values = await harness();
      const args = user.includes("\n")
        ? ["-c", `scripts/deploy-release-over-ssh.sh deploy.example 22000 'bad\nuser' ${revision}`]
        : ["scripts/deploy-release-over-ssh.sh", "deploy.example", "22000", user, revision];
      const result = spawnSync(shell, args, {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: { ...process.env, CLAIMGATE_SSH: values.ssh,
          TRACE: shellPath(values.trace), STDIN_COPY: shellPath(values.stdin),
          CLAIMGATE_ARTIFACT_DIR: values.artifacts, CLAIMGATE_GIT: values.git },
      });
      expect(result.status).not.toBe(0);
      await expect(readFile(values.trace, "utf8")).rejects.toThrow();
    },
  );

  it("passes only fixed remote command words and safe derived paths for a valid boundary id", async () => {
    const values = await harness();
    const result = run(["deploy.example", "22000", "deployer", revision], values);
    expect(result.status).toBe(0);
    expect((await readFile(values.trace, "utf8")).trim()).toBe([
      "-l deployer -p 22000 deploy.example sh -s --",
      `/var/lib/claimgate-release-upload/${revision} ${revision}`,
      `/opt/claimgate/releases/${revision} /opt/claimgate/runtime/releases/${revision}`,
    ].join(" "));
    expect(await readFile(values.stdin, "utf8")).toContain("set -eu");
  });

  it("rejects a revision that does not match the prepared artifact", async () => {
    const values = await harness("a".repeat(40));
    const result = run(["deploy.example", "22000", "deployer", "b".repeat(40)], values);
    expect(result.status).not.toBe(0);
    await expect(readFile(values.trace, "utf8")).rejects.toThrow();
  });

  it("does not invoke SSH when untracked discovery itself fails", async () => {
    const values = await harness(revision);
    await writeFile(values.git.replaceAll("/", path.sep), "#!/bin/sh\ncase \"$*\" in *ls-files*) exit 1;; *rev-parse*) echo "
      + `${revision}\n;; esac\n`, "utf8");
    const result = run(["deploy.example", "22000", "deployer", revision], values);
    expect(result.status).not.toBe(0);
    await expect(readFile(values.trace, "utf8")).rejects.toThrow();
  });
});
