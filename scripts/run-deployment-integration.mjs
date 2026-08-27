import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "claimgate-deployment-"));
const iidFile = join(temporary, "image-id");
const tag = `claimgate:deployment-${process.pid}-${Date.now()}`;
const run = (command, args, environment = {}) => spawnSync(command, args, {
  cwd: process.cwd(), encoding: "utf8", stdio: "inherit", windowsHide: true,
  env: { ...process.env, ...environment },
});
const failed = (status = 1) => { throw Object.assign(new Error("Deployment integration failed"), { status }); };

let exitCode = 0;
try {
  const build = run("docker", ["build", "--platform", "linux/amd64", "-f", "deploy/Dockerfile",
    "--iidfile", iidFile, "-t", tag, "."]);
  if (build.status !== 0) failed(build.status ?? 1);
  const imageId = readFileSync(iidFile, "utf8").trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) failed();
  const commands = [
    ["docker", ["compose", "-f", "deploy/docker-compose.example.yml", "config", "--quiet"]],
    [process.execPath, ["node_modules/vitest/vitest.mjs", "run", "scripts/deployment-linux.test.ts",
      "scripts/ingress-gate.test.ts", "scripts/release-deploy-lock.test.ts",
      "scripts/release-filesystem-gates.test.ts", "scripts/validate-release-archive.test.ts"]],
  ];
  for (const [command, args] of commands) {
    const result = run(command, args, {
      CLAIMGATE_DEPLOYMENT_LINUX: "1", CLAIMGATE_DEPLOYMENT_IMAGE: imageId,
    });
    if (result.status !== 0) failed(result.status ?? 1);
  }
} catch (error) {
  exitCode = Number.isInteger(error?.status) ? error.status : 1;
} finally {
  run("docker", ["image", "rm", "--force", tag]);
  rmSync(temporary, { force: true, recursive: true });
}
process.exitCode = exitCode;
