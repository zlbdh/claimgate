import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { normalizeEvidence } from "../src/features/evidence/normalize-evidence";

export async function freeNativePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No local port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitForExit(server: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (server.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const onExit = () => {
      clearTimeout(timer);
      resolveWait(true);
    };
    const timer = setTimeout(() => {
      server.removeListener("exit", onExit);
      resolveWait(server.exitCode !== null);
    }, timeoutMs);
    server.once("exit", onExit);
  });
}

export async function stopNativeServer(server: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (server.exitCode !== null) return;
  try { server.kill(); } catch { /* Escalate below. */ }
  if (await waitForExit(server, timeoutMs)) return;
  try { server.kill("SIGKILL"); } catch { /* The exit check remains authoritative. */ }
  if (!(await waitForExit(server, timeoutMs))) {
    throw new Error("Native standalone child did not exit after forced termination");
  }
}

export function removeNativeTemporaryDirectory(directory: string): void {
  const target = resolve(directory);
  const root = resolve(tmpdir());
  if (target === root || !`${target}${sep}`.startsWith(`${root}${sep}`)) {
    throw new Error("Refusing to remove a non-temporary native directory");
  }
  rmSync(target, { recursive: true, force: true });
}

export async function cleanupNativeRun(
  browser: { close(): Promise<void> } | undefined,
  server: ChildProcess,
  directory: string,
  timeoutMs = 3_000,
): Promise<void> {
  const errors: unknown[] = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  try { await stopNativeServer(server, timeoutMs); } catch (error) { errors.push(error); }
  try { removeNativeTemporaryDirectory(directory); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Native cleanup failed");
}

export function createEvidenceTransportCanary(): string {
  return `CG10Evidence${randomUUID().replaceAll("-", "")}`;
}

export function requireSingleTransportOccurrence(input: {
  label: string;
  url: string;
  body: string | null;
  secret: string;
}): void {
  if (
    input.url.includes(input.secret)
    || input.body === null
    || input.body.split(input.secret).length - 1 !== 1
  ) throw new Error(`${input.label} secret transport boundary failed`);
}

export function forbidRuntimeSecrets(
  surface: string,
  secrets: readonly string[],
  evidenceSecret?: string,
): void {
  const forbidden = evidenceSecret === undefined
    ? secrets
    : [...secrets, normalizeEvidence(evidenceSecret)];
  if (forbidden.some((secret) => surface.includes(secret))) {
    throw new Error("Runtime secret escaped into a forbidden browser or log surface");
  }
}
