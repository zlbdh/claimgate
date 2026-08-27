import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createKeyring } from "@/server/security/keyring";
import { createEvidenceDigester } from "@/features/evidence/evidence-digester";
import { initializeDatabase } from "./migrate";
import { createRepository, type ClaimGateRepository } from "./repository";

export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

export type TestDatabase = {
  database: Database.Database;
  databasePath: string;
  directory: string;
  repository: ClaimGateRepository;
  setNow(value: number): void;
  close(): void;
};

export function createTestDatabase(initialNow = Date.UTC(2026, 7, 26, 12)): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-db-"));
  const databasePath = join(directory, "test.sqlite");
  const database = initializeDatabase({
    databasePath,
    keyring: createKeyring(TEST_MASTER_KEY),
  });
  let currentNow = initialNow;
  let sequence = 0;
  let saltSequence = 0;
  const keyring = createKeyring(TEST_MASTER_KEY);
  const repository = createRepository({
    database,
    now: () => currentNow,
    randomId: () => `test-${++sequence}-${crypto.randomUUID()}`,
    evidenceDigester: createEvidenceDigester(keyring.getKey("evidence")),
    randomBytes: (size) => {
      const value = Buffer.alloc(size);
      value.writeUInt32BE(++saltSequence, size - 4);
      return value;
    },
  });

  return {
    database,
    databasePath,
    directory,
    repository,
    setNow(value) {
      currentNow = value;
    },
    close() {
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
