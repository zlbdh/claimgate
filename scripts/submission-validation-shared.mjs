import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 5_000;

export class SubmissionValidationFailure extends Error {
  constructor(code) {
    super("Submission validation failed.");
    this.name = "SubmissionValidationFailure";
    this.code = code;
  }
}

export function fail(code) {
  throw new SubmissionValidationFailure(code);
}

export function decodeUtf8(bytes, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
}

export async function readFileBounded(file, limit, code) {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > limit) fail(code);
    return await readFile(file);
  } catch (error) {
    if (error instanceof SubmissionValidationFailure) throw error;
    fail(code);
  }
}

export async function readResponseBounded(response, limit, code) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail(code);
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel();
        fail(code);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SubmissionValidationFailure) throw error;
    fail(code);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined;
}

export async function fetchBounded(fetcher, url, options) {
  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: options.accept },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail(options.code);
  }
  const bytes = await readResponseBounded(response, options.limit, options.code);
  return { response, bytes };
}

export function parseJson(bytes, code) {
  try { return JSON.parse(decodeUtf8(bytes, code)); } catch { fail(code); }
}

function explicitDefaultPort(value) {
  const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? "";
  const port = authority.match(/(?:\]|[^:]):(\d+)$/)?.[1];
  return port !== undefined && Number(port) === 443;
}

export function strictHttpsOrigin(value, code) {
  if (typeof value !== "string" || value.length > 2_048) fail(code);
  let parsed;
  try { parsed = new URL(value); } catch { fail(code); }
  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const reservedName = hostname === "localhost" || hostname.endsWith(".localhost")
    || /\.(?:example|invalid|local|test)$/.test(hostname);
  if (parsed.protocol !== "https:" || explicitDefaultPort(value) || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value
    || !hostname.includes(".") || reservedName || isIP(hostname) !== 0) fail(code);
  return parsed;
}

export function strictGitHubRepository(value, code) {
  if (typeof value !== "string" || value.length > 2_048) fail(code);
  let parsed;
  try { parsed = new URL(value); } catch { fail(code); }
  const match = parsed.pathname.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (parsed.protocol !== "https:" || explicitDefaultPort(value) || parsed.hostname !== "github.com" || parsed.port
    || parsed.username || parsed.password || parsed.search || parsed.hash || !match) fail(code);
  return { owner: match[1], repository: match[2] };
}

export function strictYouTubeVideo(value, code) {
  if (typeof value !== "string" || value.length > 2_048) fail(code);
  let parsed;
  try { parsed = new URL(value); } catch { fail(code); }
  const id = parsed.searchParams.get("v");
  if (parsed.protocol !== "https:" || explicitDefaultPort(value) || parsed.hostname !== "www.youtube.com" || parsed.port
    || parsed.username || parsed.password || parsed.pathname !== "/watch" || parsed.hash
    || parsed.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{11}$/.test(id ?? "")) fail(code);
  return id;
}

export function isInside(root, target) {
  const normalizedRoot = path.normalize(root);
  const normalizedTarget = path.normalize(target);
  const rootBase = path.parse(normalizedRoot).root.toLowerCase();
  const targetBase = path.parse(normalizedTarget).root.toLowerCase();
  if (rootBase !== targetBase) return false;
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
