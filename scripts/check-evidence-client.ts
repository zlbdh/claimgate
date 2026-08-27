import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeEvidence } from "../src/features/evidence/normalize-evidence";

const PRIVATE_SEED_PATH = resolve("src/server/db/private-evidence-seed.ts");
const CLIENT_STATIC_PATH = resolve(".next/static");
const PUBLIC_PATH = resolve("public");
const CLOSED_SLOTS = new Set([
  "unique_mark",
  "contents_or_accessory",
  "identifier_suffix",
]);

function fail(): never {
  throw new Error("Evidence client boundary scan failed.");
}

function readCanaries(): string[] {
  const source = readFileSync(PRIVATE_SEED_PATH, "utf8");
  const matches = [...source.matchAll(
    /\b(unique_mark|contents_or_accessory|identifier_suffix)\s*:\s*"([^"\\\r\n]+)"/g,
  )];
  if (matches.length !== 21) fail();
  const counts = new Map<string, number>();
  const canaries = matches.map((match) => {
    const slot = match[1]!;
    const value = match[2]!;
    if (!CLOSED_SLOTS.has(slot) || !/^[\x20-\x7e]+$/.test(value)) fail();
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
    return value;
  });
  if (
    new Set(canaries).size !== 21
    || [...CLOSED_SLOTS].some((slot) => counts.get(slot) !== 7)
  ) fail();
  const normalized = canaries.map(normalizeEvidence);
  if (new Set(normalized).size !== 21) fail();
  return [...canaries, ...normalized];
}

function filesUnder(root: string, required: boolean): string[] {
  if (!existsSync(root)) {
    if (required) fail();
    return [];
  }
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

function main(): void {
  const clientFiles = filesUnder(CLIENT_STATIC_PATH, true);
  if (clientFiles.length === 0) fail();
  const inspectedFiles = [...clientFiles, ...filesUnder(PUBLIC_PATH, false)];
  const canaryBuffers = readCanaries().map((value) => Buffer.from(value, "utf8"));
  for (const file of inspectedFiles) {
    const bytes = readFileSync(file);
    if (canaryBuffers.some((canary) => bytes.includes(canary))) fail();
  }
  process.stdout.write(JSON.stringify({
    evidenceClientBoundary: "PASS",
    clientFiles: clientFiles.length,
    inspectedFiles: inspectedFiles.length,
    rawCanaries: 21,
  }) + "\n");
}

main();
