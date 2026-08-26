import Database from "better-sqlite3";
import { DomainError } from "@/shared/domain-error";

export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

export function openDatabaseConnection(databasePath: string): Database.Database {
  if (!databasePath || databasePath === ":memory:") {
    throw new DomainError("CONFIGURATION_ERROR");
  }

  const database = new Database(databasePath, { timeout: DATABASE_BUSY_TIMEOUT_MS });
  try {
    database.pragma("foreign_keys = ON");
    if (database.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new DomainError("CONFIGURATION_ERROR");
    }
    if (database.pragma("journal_mode = WAL", { simple: true }) !== "wal") {
      throw new DomainError("CONFIGURATION_ERROR");
    }
    database.pragma("synchronous = FULL");
    database.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
