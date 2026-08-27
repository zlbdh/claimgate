import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEALTH_PATH = "/api/health";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256;
const MAX_ORIGIN_CHARACTERS = 2_048;
const SUCCESS_BODY = '{"status":"healthy"}';
const USAGE = "Usage: node scripts/healthcheck.mjs <origin>\n";
const PASSED = "ClaimGate health check passed.\n";
const FAILED = "ClaimGate health check failed.\n";

function parseOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_CHARACTERS) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.origin === "null"
    ) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

async function readBoundedBody(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declaredLength)) throw new Error("Invalid response length");
    if (Number(declaredLength) > MAX_RESPONSE_BYTES) throw new Error("Response too large");
  }
  if (response.body === null) throw new Error("Missing response body");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

async function probe(origin, fetcher) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetcher(`${origin}${HEALTH_PATH}`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (
      response.status !== 200
      || response.headers.get("content-type") !== "application/json"
      || response.headers.get("cache-control") !== "private, no-store"
    ) return false;
    return await readBoundedBody(response) === SUCCESS_BODY;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runHealthcheckCli(args, dependencies = {}) {
  const writeOut = dependencies.writeOut ?? ((value) => process.stdout.write(value));
  const writeError = dependencies.writeError ?? ((value) => process.stderr.write(value));
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  if (!Array.isArray(args) || args.length !== 1) {
    writeError(USAGE);
    return 2;
  }
  const origin = parseOrigin(args[0]);
  if (origin === undefined || typeof fetcher !== "function") {
    writeError(USAGE);
    return 2;
  }
  if (await probe(origin, fetcher)) {
    writeOut(PASSED);
    return 0;
  }
  writeError(FAILED);
  return 3;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await runHealthcheckCli(process.argv.slice(2));
}
