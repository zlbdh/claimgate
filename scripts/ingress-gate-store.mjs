import { Buffer } from "node:buffer";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";

export const INGRESS_GATE_LIMIT = 5;
export const INGRESS_GATE_WINDOW_MS = 600_000;
export const INGRESS_GATE_MAX_ACTIVE_SOURCES = 4_096;
export const INGRESS_GATE_BUSY_TIMEOUT_MS = 0;

const SCHEMA_VERSION = 1;
const KEY_LENGTH_BYTES = 32;
const HKDF_SALT = Buffer.from("ClaimGate/ingress-gate/v1", "utf8");
const KEY_CHECK_CONTEXT = Buffer.from("ClaimGate/ingress-gate/key-check/v1", "utf8");

function configurationError() {
  return new Error("Invalid ingress gate configuration");
}

function decodeMasterKey(value) {
  if (
    typeof value !== "string"
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) throw configurationError();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < KEY_LENGTH_BYTES || decoded.toString("base64") !== value) {
    throw configurationError();
  }
  return decoded;
}

function deriveKey(master, purpose) {
  return Buffer.from(hkdfSync(
    "sha256",
    master,
    HKDF_SALT,
    Buffer.from(`ClaimGate/ingress-gate/${purpose}/v1`, "utf8"),
    KEY_LENGTH_BYTES,
  ));
}

function requireDatabasePath(value) {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || value === ":memory:"
    || value.startsWith("\\\\")
    || value.startsWith("//")
    || value.includes("\0")
  ) throw configurationError();
  return value;
}

export function normalizeIngressSource(value) {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 45
    || value.trim() !== value
    || value.includes(",")
  ) return undefined;
  const family = isIP(value);
  if (family === 0) return undefined;
  try {
    if (family === 6) {
      const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
      if (mapped && isIP(mapped[1]) === 4) return `4:${mapped[1]}`;
      const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
      if (hexadecimal) {
        const integer = (Number.parseInt(hexadecimal[1], 16) * 65_536)
          + Number.parseInt(hexadecimal[2], 16);
        return `4:${[24, 16, 8, 0].map((shift) => (integer >>> shift) & 255).join(".")}`;
      }
    }
    const parsed = new URL(family === 6 ? `http://[${value}]/` : `http://${value}/`);
    const host = family === 6 ? parsed.hostname.slice(1, -1).toLowerCase() : parsed.hostname;
    return `${family}:${host}`;
  } catch {
    return undefined;
  }
}

function keyCheck(key) {
  return createHmac("sha256", key).update(KEY_CHECK_CONTEXT).digest();
}

function sourceDigest(key, normalizedSource) {
  return createHmac("sha256", key)
    .update("ClaimGate/ingress-gate/source/v1\0", "utf8")
    .update(normalizedSource, "utf8")
    .digest();
}

function requireNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw configurationError();
  return value;
}

export function assertWindowWritePostcondition(changes, persisted, serialized, effectiveNow) {
  if (changes !== 1 || persisted?.eventTimesJson !== serialized
    || persisted?.lastEventAtMs !== effectiveNow) throw configurationError();
}

function parseEventTimes(value, lastEventAt, effectiveNow) {
  if (typeof value !== "string" || value.length > 128) throw configurationError();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw configurationError();
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > INGRESS_GATE_LIMIT
    || JSON.stringify(parsed) !== value
  ) throw configurationError();
  for (let index = 0; index < parsed.length; index += 1) {
    const time = parsed[index];
    if (
      !Number.isSafeInteger(time)
      || time < 0
      || time > effectiveNow
      || (index > 0 && time < parsed[index - 1])
    ) throw configurationError();
  }
  if (parsed.at(-1) !== lastEventAt) throw configurationError();
  return parsed;
}

function requireSchemaObjects(database) {
  const objects = database.prepare(`
    SELECT type, name, tbl_name AS tableName FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all();
  const expected = [
    { type: "index", name: "ingress_source_windows_expiry", tableName: "ingress_source_windows" },
    { type: "table", name: "ingress_gate_clock", tableName: "ingress_gate_clock" },
    { type: "table", name: "ingress_gate_metadata", tableName: "ingress_gate_metadata" },
    { type: "table", name: "ingress_source_windows", tableName: "ingress_source_windows" },
  ];
  const temporary = database.prepare("SELECT 1 FROM sqlite_temp_schema LIMIT 1").get();
  if (JSON.stringify(objects) !== JSON.stringify(expected) || temporary) {
    throw configurationError();
  }
}

function initialize(database, check) {
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
  database.pragma(`busy_timeout = ${INGRESS_GATE_BUSY_TIMEOUT_MS}`);
  if (database.pragma("journal_mode = WAL", { simple: true }) !== "wal") {
    throw configurationError();
  }
  database.pragma("synchronous = FULL");
  const version = database.pragma("user_version", { simple: true });
  if (version === 0) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE ingress_gate_metadata (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          key_check BLOB NOT NULL CHECK (length(key_check) = 32),
          limit_value INTEGER NOT NULL CHECK (limit_value = 5),
          window_ms INTEGER NOT NULL CHECK (window_ms = 600000),
          max_active_sources INTEGER NOT NULL CHECK (max_active_sources = 4096)
        ) STRICT;
        CREATE TABLE ingress_gate_clock (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          high_water_time_ms INTEGER NOT NULL CHECK (high_water_time_ms >= 0)
        ) STRICT;
        CREATE TABLE ingress_source_windows (
          source_digest BLOB PRIMARY KEY CHECK (length(source_digest) = 32),
          event_times_json TEXT NOT NULL CHECK (length(event_times_json) BETWEEN 3 AND 128),
          last_event_at_ms INTEGER NOT NULL CHECK (last_event_at_ms >= 0)
        ) STRICT;
        CREATE INDEX ingress_source_windows_expiry
          ON ingress_source_windows (last_event_at_ms);
      `);
      const metadataWrite = database.prepare(`
        INSERT INTO ingress_gate_metadata (
          singleton_id, schema_version, key_check, limit_value, window_ms, max_active_sources
        ) VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        SCHEMA_VERSION,
        check,
        INGRESS_GATE_LIMIT,
        INGRESS_GATE_WINDOW_MS,
        INGRESS_GATE_MAX_ACTIVE_SOURCES,
      );
      if (metadataWrite.changes !== 1) throw configurationError();
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    }).immediate();
  } else if (version !== SCHEMA_VERSION) {
    throw configurationError();
  }
  requireSchemaObjects(database);
  const metadata = database.prepare(`
    SELECT schema_version AS schemaVersion, key_check AS keyCheck,
      limit_value AS limitValue, window_ms AS windowMs,
      max_active_sources AS maxActiveSources
    FROM ingress_gate_metadata WHERE singleton_id = 1
  `).get();
  const storedCheck = Buffer.from(metadata?.keyCheck ?? []);
  if (
    metadata?.schemaVersion !== SCHEMA_VERSION
    || metadata?.limitValue !== INGRESS_GATE_LIMIT
    || metadata?.windowMs !== INGRESS_GATE_WINDOW_MS
    || metadata?.maxActiveSources !== INGRESS_GATE_MAX_ACTIVE_SOURCES
    || storedCheck.length !== check.length
    || !timingSafeEqual(storedCheck, check)
  ) throw configurationError();
}

export function createIngressGateStore(options) {
  const master = decodeMasterKey(options?.key);
  const digestKey = deriveKey(master, "source-digest");
  const check = keyCheck(deriveKey(master, "key-check"));
  const database = new Database(requireDatabasePath(options?.databasePath), { timeout: 0 });
  const now = options?.now ?? Date.now;
  try {
    initialize(database, check);
  } catch (error) {
    database.close();
    throw error;
  }

  const readClock = database.prepare(`
    SELECT high_water_time_ms AS highWaterTimeMs
    FROM ingress_gate_clock WHERE singleton_id = 1
  `);
  const writeClock = database.prepare(`
    INSERT INTO ingress_gate_clock (singleton_id, high_water_time_ms) VALUES (1, ?)
    ON CONFLICT (singleton_id) DO UPDATE SET
      high_water_time_ms = MAX(high_water_time_ms, excluded.high_water_time_ms)
  `);
  const prune = database.prepare("DELETE FROM ingress_source_windows WHERE last_event_at_ms <= ?");
  const readWindow = database.prepare(`
    SELECT event_times_json AS eventTimesJson, last_event_at_ms AS lastEventAtMs
    FROM ingress_source_windows WHERE source_digest = ?
  `);
  const countSources = database.prepare("SELECT COUNT(*) AS count FROM ingress_source_windows");
  const writeWindow = database.prepare(`
    INSERT INTO ingress_source_windows (source_digest, event_times_json, last_event_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT (source_digest) DO UPDATE SET
      event_times_json = excluded.event_times_json,
      last_event_at_ms = excluded.last_event_at_ms
  `);

  const consumeTransaction = database.transaction((digest) => {
    requireSchemaObjects(database);
    const currentTime = requireNow(now);
    const clock = readClock.get();
    const effectiveNow = Math.max(currentTime, clock?.highWaterTimeMs ?? currentTime);
    const clockWrite = writeClock.run(effectiveNow);
    if (clockWrite.changes !== 1 || readClock.get()?.highWaterTimeMs !== effectiveNow) {
      throw configurationError();
    }
    const threshold = effectiveNow - INGRESS_GATE_WINDOW_MS;
    prune.run(threshold);
    const row = readWindow.get(digest);
    const active = row
      ? parseEventTimes(row.eventTimesJson, row.lastEventAtMs, effectiveNow)
        .filter((time) => time > threshold)
      : [];
    if (active.length >= INGRESS_GATE_LIMIT) {
      return { allowed: false, retryAfterMs: Math.max(1, active[0] + INGRESS_GATE_WINDOW_MS - effectiveNow) };
    }
    if (!row && countSources.get().count >= INGRESS_GATE_MAX_ACTIVE_SOURCES) {
      return { allowed: false, retryAfterMs: INGRESS_GATE_WINDOW_MS };
    }
    active.push(effectiveNow);
    const serialized = JSON.stringify(active);
    const windowWrite = writeWindow.run(digest, serialized, effectiveNow);
    const persisted = readWindow.get(digest);
    assertWindowWritePostcondition(windowWrite.changes, persisted, serialized, effectiveNow);
    return { allowed: true, retryAfterMs: 0 };
  });

  let closed = false;
  return Object.freeze({
    consume(source) {
      if (closed) throw configurationError();
      const normalized = normalizeIngressSource(source);
      if (normalized === undefined) throw configurationError();
      return consumeTransaction.immediate(sourceDigest(digestKey, normalized));
    },
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  });
}
