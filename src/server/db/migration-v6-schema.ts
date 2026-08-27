import type Database from "better-sqlite3";
import { DomainError } from "@/shared/domain-error";

function assertLegacyV5Compatible(database: Database.Database): void {
  const invalid = database.prepare(`
    SELECT 1 FROM claims
    WHERE pickup_pass_salt IS NOT NULL
      OR pickup_pass_digest IS NOT NULL
      OR pickup_pass_expires_at_ms IS NOT NULL
      OR typeof(pass_generation) <> 'integer'
      OR pass_generation <> 0
      OR status IN ('PICKUP_READY', 'COLLECTED')
    LIMIT 1
  `).get();
  if (invalid) throw new DomainError("CONFIGURATION_ERROR");
}

export function addV6PickupSchema(
  database: Database.Database,
  schemaSql: string,
): void {
  assertLegacyV5Compatible(database);
  database.exec(`
    ALTER TABLE claims ADD COLUMN pickup_pass_consumed_at_ms
      CHECK (
        pickup_pass_consumed_at_ms IS NULL
        OR (typeof(pickup_pass_consumed_at_ms) = 'integer'
          AND pickup_pass_consumed_at_ms BETWEEN 0 AND 9007199254740991)
      );
    DROP INDEX IF EXISTS idempotency_records_instance_idx;
    ALTER TABLE idempotency_records RENAME TO idempotency_records_v5;
    DROP INDEX IF EXISTS claim_events_claim_time_idx;
    ALTER TABLE claim_events RENAME TO claim_events_v5;
  `);
  database.exec(schemaSql);
  database.exec(`
    INSERT INTO idempotency_records (
      demo_instance_id, actor_id, action, key_digest,
      request_fingerprint_digest, result_json, created_at_ms
    )
    SELECT demo_instance_id, actor_id, action, key_digest,
      request_fingerprint_digest, result_json, created_at_ms
    FROM idempotency_records_v5;

    INSERT INTO claim_events (
      demo_instance_id, id, claim_id, event_type, actor_id, result, occurred_at_ms
    )
    SELECT demo_instance_id, id, claim_id, event_type, actor_id, result, occurred_at_ms
    FROM claim_events_v5;

    DROP TABLE idempotency_records_v5;
    DROP TABLE claim_events_v5;
  `);
}
