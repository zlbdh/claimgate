import { randomBytes } from "node:crypto";
import {
  createPickupPassCrypto,
  parsePickupPassToken,
} from "@/features/claims/pickup-pass-crypto";
import { createKeyring } from "@/server/security/keyring";

type FixtureInput = Readonly<{
  demoInstanceId: string;
  claimId: string;
  token: string;
  generation: number;
  version: number;
  masterKey: string;
}>;

function parseInput(serialized: string): FixtureInput {
  const value = JSON.parse(serialized) as unknown;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("invalid fixture input");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "claimId,demoInstanceId,generation,masterKey,token,version") {
    throw new Error("invalid fixture input");
  }
  if (
    typeof record.demoInstanceId !== "string" || record.demoInstanceId.length < 1
    || record.demoInstanceId.length > 512
    || typeof record.claimId !== "string" || record.claimId.length < 1
    || record.claimId.length > 512
    || typeof record.token !== "string"
    || !Number.isSafeInteger(record.generation) || Number(record.generation) < 1
    || !Number.isSafeInteger(record.version) || Number(record.version) < 1
    || typeof record.masterKey !== "string" || record.masterKey.length > 256
  ) throw new Error("invalid fixture input");
  parsePickupPassToken(record.token);
  return record as FixtureInput;
}

async function readInput(): Promise<string> {
  let serialized = "";
  for await (const chunk of process.stdin) {
    serialized += String(chunk);
    if (serialized.length > 4_096) throw new Error("fixture input too large");
  }
  return serialized;
}

async function main(): Promise<void> {
  const input = parseInput(await readInput());
  const generation = input.generation + 1;
  const expiresAtMs = Math.max(1, Date.now() - 5_000);
  const salt = randomBytes(32);
  const pickupCrypto = createPickupPassCrypto(
    createKeyring(input.masterKey).getKey("pickup-pass"),
  );
  const digest = pickupCrypto.digest({
    demoInstanceId: input.demoInstanceId,
    claimId: input.claimId,
    generation,
    expiresAtMs,
    salt,
    tokenBytes: parsePickupPassToken(input.token),
  });
  process.stdout.write(JSON.stringify({
    salt: salt.toString("base64"),
    digest: digest.toString("base64"),
    generation,
    expiresAtMs,
  }));
}

void main().catch(() => {
  process.exitCode = 1;
});
