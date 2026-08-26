import "server-only";

import { isAbsolute } from "node:path";
import { createPersistentGlobalRateLimiter } from "@/server/security/global-rate-limit";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { DomainError } from "@/shared/domain-error";
import { initializeDatabase } from "./migrate";
import { createRepository } from "./repository";

let runtime: ReturnType<typeof createRuntime> | undefined;

function requireLocalDatabasePath(value: string | undefined): string {
  if (
    !value
    || !isAbsolute(value)
    || value === ":memory:"
    || value.startsWith("\\\\")
    || value.startsWith("//")
    || value.includes("\0")
  ) throw new DomainError("CONFIGURATION_ERROR");
  return value;
}

function createRuntime() {
  const database = initializeDatabase({
    databasePath: requireLocalDatabasePath(process.env.CLAIMGATE_DATABASE_PATH),
    keyring: createKeyring(process.env.CLAIMGATE_HMAC_KEY),
  });
  return Object.freeze({
    database,
    repository: createRepository({ database }),
    limiter: createPersistentRateLimiter({ database }),
    globalLimiter: createPersistentGlobalRateLimiter({ database }),
  });
}

export function getDatabaseRuntime(): ReturnType<typeof createRuntime> {
  runtime ??= createRuntime();
  return runtime;
}
