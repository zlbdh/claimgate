import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeEvidence } from "../src/features/evidence/normalize-evidence";

const STATIC_ROOT = resolve(".next/static");
const PUBLIC_ROOT = resolve("public");
const STANDALONE_SERVER_ROOT = resolve(".next/standalone/.next/server");
const PRIVATE_SEED_PATH = resolve("src/server/db/private-evidence-seed.ts");

function fail(label: string): never {
  throw new Error(`Secret surface scan failed: ${label}.`);
}

function filesUnder(root: string, required = false): string[] {
  if (!existsSync(root)) {
    if (required) fail("required build surface missing");
    return [];
  }
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

function seedCanaries(): Buffer[] {
  const source = readFileSync(PRIVATE_SEED_PATH, "utf8");
  const values = [...source.matchAll(
    /\b(?:unique_mark|contents_or_accessory|identifier_suffix)\s*:\s*"([^"\\\r\n]+)"/g,
  )].map((match) => match[1]!);
  if (values.length !== 21 || new Set(values).size !== 21) fail("private seed inventory changed");
  const normalized = values.map(normalizeEvidence);
  return [...new Set([...values, ...normalized])].map((value) => Buffer.from(value, "utf8"));
}

function main(): void {
  const publicFiles = [...filesUnder(STATIC_ROOT, true), ...filesUnder(PUBLIC_ROOT)];
  if (publicFiles.length === 0) fail("public build was empty");
  const canaries = seedCanaries();
  const serverOnlyMarkers = [
    "private-evidence-seed",
    "ClaimGate/evidence/v1",
    "ClaimGate/pickup-pass/v1",
    "pickup_pass_digest",
    "runPickupIssuanceIdempotent",
    "CLAIMGATE_HMAC_KEY",
    "CLAIMGATE_SESSION_KEY",
    "CLAIMGATE_CSRF_KEY",
  ].map((value) => Buffer.from(value, "utf8"));

  for (const file of publicFiles) {
    if (file.endsWith(".map")) fail("public source map present");
    const bytes = readFileSync(file);
    if (canaries.some((canary) => bytes.includes(canary))) fail("private evidence in public build");
    if (serverOnlyMarkers.some((marker) => bytes.includes(marker))) fail("server marker in public build");
    if (bytes.includes(Buffer.from("sourceMappingURL=", "utf8"))) {
      fail("public source-map reference present");
    }
  }

  const standaloneMaps = filesUnder(STANDALONE_SERVER_ROOT, true)
    .filter((file) => file.endsWith(".map"));
  for (const file of standaloneMaps) {
    const bytes = readFileSync(file);
    if (bytes.includes(Buffer.from('"sourcesContent"', "utf8"))) {
      fail("standalone server source map embeds sources");
    }
  }

  process.stdout.write(JSON.stringify({
    secretSurfaces: "PASS",
    publicFiles: publicFiles.length,
    publicSourceMaps: 0,
    standaloneMapsChecked: standaloneMaps.length,
    rawEvidenceCanaries: 21,
  }) + "\n");
}

main();
