import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const directories: string[] = [];
let shell: string;
const shellPath = (value: string) => value.replaceAll("\\", "/");

beforeAll(() => {
  shell = ["sh", "C:/Program Files/Git/bin/sh.exe", "C:/Program Files/Git/usr/bin/sh.exe"]
    .find((candidate) => spawnSync(candidate, ["-c", "exit 0"], { windowsHide: true }).status === 0) ?? "";
  if (!shell) throw new Error("Git POSIX sh is required");
});
afterEach(async () => Promise.all(directories.splice(0).map((directory) =>
  rm(directory, { force: true, recursive: true }))));

async function executable(target: string, lines: string[]): Promise<void> {
  await writeFile(target, `#!/bin/sh\nset -eu\n${lines.join("\n")}\n`, "utf8");
  await chmod(target, 0o755);
}

describe("server release filesystem gates", () => {
  const revision = "0".repeat(40);
  it.each([
    "upload-symlink", "upload-owner", "upload-mode", "file-nonregular", "file-symlink",
    "file-owner", "file-mode",
    "dangling-app", "dangling-runtime", "existing-app", "existing-runtime",
    "parent-symlink", "parent-mode", "target-rename",
  ])("fails %s before every downstream command", async (scenario) => {
    const root = await mkdtemp(path.join(tmpdir(), "claimgate-fs-gate-"));
    directories.push(root);
    const bin = path.join(root, "bin");
    const realUpload = path.join(root, "real-upload");
    let upload = path.join(root, "upload");
    const releaseRoot = path.join(root, "claimgate");
    const app = path.join(releaseRoot, `releases/${revision}`);
    const runtime = path.join(releaseRoot, `runtime/releases/${revision}`);
    const trace = path.join(root, "trace");
    await mkdir(bin);
    await mkdir(realUpload);
    if (scenario === "parent-symlink") {
      const realReleaseRoot = path.join(root, "real-claimgate");
      await mkdir(path.join(realReleaseRoot, "releases"), { recursive: true });
      await mkdir(path.join(realReleaseRoot, "runtime/releases"), { recursive: true });
      await symlink(realReleaseRoot, releaseRoot, "junction");
    } else {
      await mkdir(path.join(releaseRoot, "releases"), { recursive: true });
      await mkdir(path.join(releaseRoot, "runtime/releases"), { recursive: true });
    }
    await writeFile(trace, "", "utf8");
    if (scenario === "upload-symlink") await symlink(realUpload, upload, "junction");
    else { upload = realUpload; }
    const hash = "0".repeat(64);
    await writeFile(path.join(realUpload, "SHA256SUMS.txt"), [
      `${hash}  claimgate-app-linux-amd64.tar.gz`,
      `${hash}  node-v22.20.0-linux-x64.tar.gz`,
      `${hash}  validate-release-archive.py`,
      `${hash}  CLAIMGATE_REVISION`, "",
    ].join("\n"), "utf8");
    await writeFile(path.join(realUpload, "CLAIMGATE_REVISION"), revision, "utf8");
    for (const file of ["claimgate-app-linux-amd64.tar.gz",
      "node-v22.20.0-linux-x64.tar.gz", "validate-release-archive.py"]) {
      await writeFile(path.join(realUpload, file), "fixture", "utf8");
    }
    if (scenario === "file-nonregular" || scenario === "file-symlink") {
      await rm(path.join(realUpload, "validate-release-archive.py"));
      if (scenario === "file-nonregular") await mkdir(path.join(realUpload, "validate-release-archive.py"));
      else {
        const target = path.join(root, "validator-target");
        await mkdir(target);
        await symlink(target, path.join(realUpload, "validate-release-archive.py"), "junction");
      }
    }
    if (scenario.includes("app")) {
      await mkdir(path.dirname(app), { recursive: true });
      if (scenario === "existing-app") await mkdir(app);
      else await symlink(path.join(root, "missing-app"), app, "junction");
    }
    if (scenario.includes("runtime")) {
      await mkdir(path.dirname(runtime), { recursive: true });
      if (scenario === "existing-runtime") await mkdir(runtime);
      else await symlink(path.join(root, "missing-runtime"), runtime, "junction");
    }
    const stat = path.join(bin, "stat");
    await executable(stat, [
      "for target; do :; done",
      'if [ "$STAT_SCENARIO" = upload-owner ]; then printf "nobody:root 700\\n"; exit 0; fi',
      'if [ "$STAT_SCENARIO" = upload-mode ]; then printf "root:root 755\\n"; exit 0; fi',
      'if [ "$STAT_SCENARIO" = file-owner ] && echo "$*" | grep -q validate-release; then printf "nobody:root 600\\n"; exit 0; fi',
      'if [ "$STAT_SCENARIO" = file-mode ] && echo "$*" | grep -q validate-release; then printf "root:root 644\\n"; exit 0; fi',
      'if [ "$STAT_SCENARIO" = parent-mode ] && echo "$*" | grep -q claimgate; then printf "root:root 777\\n"; exit 0; fi',
      'if [ "$target" = "$FS_ROOT" ] || [ "$target" = "$REAL_UPLOAD" ]; then echo root:root 700; exit; fi',
      'case "$target" in SHA256SUMS.txt|CLAIMGATE_REVISION|*.tar.gz|*.py) echo root:root 600;; *) echo root:root 755;; esac',
    ]);
    const environment: NodeJS.ProcessEnv = {
      ...process.env, CLAIMGATE_RELEASE_ROOT: shellPath(releaseRoot),
      CLAIMGATE_UPLOAD_ROOT: shellPath(root),
      CLAIMGATE_DEPLOY_LOCK_ROOT: shellPath(realUpload),
      CLAIMGATE_STAT: shellPath(stat), STAT_SCENARIO: scenario, TRACE: shellPath(trace),
      FS_ROOT: shellPath(root), REAL_UPLOAD: shellPath(realUpload),
    };
    for (const command of ["sha256sum", "systemd-run", "install", "tar"]) {
      const target = path.join(bin, command);
      await executable(target, [`echo "${command}:$*" >> "$TRACE"`]);
      environment[`CLAIMGATE_${command.replace("-", "_").toUpperCase()}`] = shellPath(target);
    }
    const passedApp = scenario === "target-rename" ? `${app}x` : app;
    const result = spawnSync(shell, ["scripts/verify-release-artifacts.sh",
      shellPath(upload), revision, shellPath(passedApp), shellPath(runtime)], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: environment,
    });
    expect(result.status).not.toBe(0);
    expect(await readFile(trace, "utf8")).toBe("");
  }, 15_000);

  it("on Linux rejects a symlink-to-regular after the -f gate but before downstream", () => {
    const verifier = shellPath(path.resolve(process.cwd(), "scripts/verify-release-artifacts.sh"));
    const script = [
      "set -eu", "mkdir -p /tmp/upload /tmp/bin /tmp/claimgate/releases /tmp/claimgate/runtime/releases", "chmod 700 /tmp/upload", ": > /tmp/trace",
      "touch /tmp/upload/claimgate-app-linux-amd64.tar.gz /tmp/upload/node-v22.20.0-linux-x64.tar.gz",
      "touch /tmp/validator-target", "ln -s /tmp/validator-target /tmp/upload/validate-release-archive.py",
      "test -f /tmp/upload/validate-release-archive.py", "test -L /tmp/upload/validate-release-archive.py",
      "h=$(printf '%064d' 0)",
      "printf '%s  %s\\n%s  %s\\n%s  %s\\n' \"$h\" claimgate-app-linux-amd64.tar.gz \"$h\" node-v22.20.0-linux-x64.tar.gz \"$h\" validate-release-archive.py > /tmp/upload/SHA256SUMS.txt",
      `printf '%s\\n' ${revision} > /tmp/upload/CLAIMGATE_REVISION`,
      "printf '%s  %s\\n' \"$h\" CLAIMGATE_REVISION >> /tmp/upload/SHA256SUMS.txt",
      "chmod 600 /tmp/upload/* /tmp/validator-target",
      "printf '#!/bin/sh\\nfor target; do :; done\\ncase \"$target\" in /tmp|/tmp/upload) echo root:root 700;; SHA256SUMS.txt|CLAIMGATE_REVISION|*.tar.gz|*.py) echo root:root 600;; *) echo root:root 755;; esac\\n' > /tmp/bin/stat",
      "for c in sha256sum systemd-run install tar; do printf '#!/bin/sh\\necho called >> /tmp/trace\\n' > /tmp/bin/$c; chmod +x /tmp/bin/$c; done",
      "chmod +x /tmp/bin/stat", "set +e",
      `CLAIMGATE_RELEASE_ROOT=/tmp/claimgate CLAIMGATE_UPLOAD_ROOT=/tmp CLAIMGATE_DEPLOY_LOCK_ROOT=/tmp/upload CLAIMGATE_STAT=/tmp/bin/stat CLAIMGATE_SHA256SUM=/tmp/bin/sha256sum CLAIMGATE_SYSTEMD_RUN=/tmp/bin/systemd-run CLAIMGATE_INSTALL=/tmp/bin/install CLAIMGATE_TAR=/tmp/bin/tar sh /verify.sh /tmp/upload ${revision} /tmp/claimgate/releases/${revision} /tmp/claimgate/runtime/releases/${revision}`,
      "status=$?", "set -e", "test $status -ne 0", "test ! -s /tmp/trace",
    ].join("\n");
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only",
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=16m", "--mount",
      `type=bind,src=${verifier},dst=/verify.sh,readonly`,
      "debian:12-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171",
      "sh", "-ceu", script], { encoding: "utf8", windowsHide: true });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  }, 15_000);
});
