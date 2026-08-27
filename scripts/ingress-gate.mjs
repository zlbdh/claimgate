import { chmodSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createIngressGateServer } from "./ingress-gate-http.mjs";
import { createIngressGateStore } from "./ingress-gate-store.mjs";

export const INGRESS_GATE_SOCKET_PATH = "/run/claimgate-ingress-gate/gate.sock";
export const INGRESS_GATE_DATABASE_PATH = "/var/lib/claimgate-ingress-gate/ingress-gate.db";
const FIXED_FAILURE = "ClaimGate ingress gate failed.\n";

function removeStaleSocket() {
  try {
    const stat = lstatSync(INGRESS_GATE_SOCKET_PATH);
    if (!stat.isSocket()) throw new Error("Invalid ingress gate socket");
    rmSync(INGRESS_GATE_SOCKET_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runIngressGate(options = {}) {
  const store = createIngressGateStore({
    databasePath: options.databasePath ?? INGRESS_GATE_DATABASE_PATH,
    key: options.key ?? process.env.CLAIMGATE_INGRESS_KEY,
    now: options.now,
  });
  let server;
  try {
    server = createIngressGateServer({
      consume: store.consume,
    });
    removeStaleSocket();
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(INGRESS_GATE_SOCKET_PATH, resolveListen);
    });
    chmodSync(INGRESS_GATE_SOCKET_PATH, 0o660);
  } catch (error) {
    if (server?.listening) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    rmSync(INGRESS_GATE_SOCKET_PATH, { force: true });
    store.close();
    throw error;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      store.close();
      rmSync(INGRESS_GATE_SOCKET_PATH, { force: true });
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return Object.freeze({ server, store, stop });
}

const entryPath = process.argv[1];
// 2026-08-28 by Codex — systemd 通过 current 符号链接启动，入口判断必须比较真实路径。
if (entryPath && import.meta.url === pathToFileURL(realpathSync(resolve(entryPath))).href) {
  try {
    const runtime = await runIngressGate();
    runtime.server.on("error", () => {
      process.stderr.write(FIXED_FAILURE);
      runtime.stop();
      process.exitCode = 1;
    });
  } catch {
    process.stderr.write(FIXED_FAILURE);
    process.exitCode = 1;
  }
}
