import type Database from "better-sqlite3";
import { DomainError } from "@/shared/domain-error";

function assertLegacyClaimsV5Compatible(database: Database.Database): void {
  const invalid = database.prepare(`
    SELECT 1 FROM claims WHERE COALESCE((
      typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 3
      AND typeof(evidence_eligible) = 'integer' AND evidence_eligible IN (0, 1)
      AND typeof(unlock_count) = 'integer' AND unlock_count = 0
      AND rejection_reason IS NULL
      AND (reviewer_actor_id IS NULL OR reviewer_actor_id = 'staff-demo')
      AND (
        (status = 'EVIDENCE_REQUIRED' AND attempts BETWEEN 0 AND 2
          AND evidence_eligible = 0 AND reviewer_actor_id IS NULL)
        OR (status = 'LOCKED' AND attempts = 3
          AND evidence_eligible = 0 AND reviewer_actor_id IS NULL)
        OR (status = 'UNDER_REVIEW' AND attempts BETWEEN 0 AND 2
          AND evidence_eligible = 1 AND reviewer_actor_id IS NULL)
        OR (status IN ('APPROVED', 'PICKUP_READY', 'COLLECTED')
          AND attempts BETWEEN 0 AND 2 AND evidence_eligible = 1
          AND reviewer_actor_id = 'staff-demo')
      )
    ), 0) = 0 LIMIT 1
  `).get();
  if (invalid) throw new DomainError("CONFIGURATION_ERROR");
}

export function addV5ClaimAndIdempotencySchema(
  database: Database.Database,
  schemaSql: string,
): void {
  database.exec(`
    ALTER TABLE claims ADD COLUMN rejection_reason TEXT CHECK (
      rejection_reason IS NULL OR rejection_reason IN (
        'STAFF_REJECTED', 'ITEM_HELD_BY_ANOTHER_CLAIM'
      )
    );
    ALTER TABLE claims ADD COLUMN unlock_count INTEGER NOT NULL DEFAULT 0 CHECK (
      typeof(unlock_count) = 'integer' AND unlock_count BETWEEN 0 AND 1
    );
  `);
  assertLegacyClaimsV5Compatible(database);
  database.exec(`
    DROP INDEX IF EXISTS claims_single_approved_item_idx;
    ALTER TABLE idempotency_records RENAME TO idempotency_records_v4;
    DROP INDEX IF EXISTS idempotency_records_instance_idx;
  `);
  database.exec(schemaSql);
  database.exec(`
    INSERT INTO idempotency_records (
      demo_instance_id, actor_id, action, key_digest,
      request_fingerprint_digest, result_json, created_at_ms
    )
    SELECT demo_instance_id, actor_id, action, key_digest,
      request_fingerprint_digest, result_json, created_at_ms
    FROM idempotency_records_v4;
    DROP TABLE idempotency_records_v4;
  `);
}
