import { resolve } from "node:path";
import Database from "better-sqlite3";
import { verifyConfiguredDatabaseKey } from "./database-authenticator.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const [databasePathArgument, ...flags] = process.argv.slice(2);
if (!databasePathArgument || databasePathArgument.startsWith("--")) {
  fail("Usage: node scripts/reset-expired-demo-instances.mjs <database-path> [--apply] [--now-ms=<integer>]");
} else {
  const unknownFlags = flags.filter((flag) => flag !== "--apply" && !flag.startsWith("--now-ms="));
  const nowFlags = flags.filter((flag) => flag.startsWith("--now-ms="));
  if (unknownFlags.length > 0 || nowFlags.length > 1) {
    fail("Unsupported argument.");
  } else {
    const apply = flags.includes("--apply");
    const nowMs = nowFlags.length === 1 ? Number(nowFlags[0].slice("--now-ms=".length)) : Date.now();
    if (!Number.isFinite(nowMs) || !Number.isInteger(nowMs)) {
      fail("--now-ms must be a finite integer.");
    } else {
      const databasePath = resolve(databasePathArgument);
      let database;
      try {
        database = new Database(databasePath, { readonly: !apply, fileMustExist: true, timeout: 5_000 });
        database.pragma("foreign_keys = ON");
        if (database.pragma("foreign_keys", { simple: true }) !== 1) {
          throw new Error("foreign keys unavailable");
        }
        if (database.pragma("journal_mode", { simple: true }) !== "wal") {
          throw new Error("WAL unavailable");
        }
        database.pragma("synchronous = FULL");
        database.pragma("busy_timeout = 5000");
        const countExpired = () => database.prepare(
          "SELECT COUNT(*) AS count FROM demo_instances WHERE expires_at_ms <= ?",
        ).get(nowMs).count;
        let count;
        if (apply) {
          count = database.transaction(() => {
            verifyConfiguredDatabaseKey(database, process.env.CLAIMGATE_HMAC_KEY);
            const expiredInstances = countExpired();
            database.prepare("DELETE FROM demo_instances WHERE expires_at_ms <= ?").run(nowMs);
            return expiredInstances;
          }).immediate();
        } else {
          count = countExpired();
        }
        process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry-run", expiredInstances: count })}\n`);
      } catch {
        fail("Unable to inspect or reset the ClaimGate database.");
      } finally {
        if (database?.open) database.close();
      }
    }
  }
}
