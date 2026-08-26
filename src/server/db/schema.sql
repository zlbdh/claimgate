CREATE TABLE IF NOT EXISTS database_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  database_uuid TEXT NOT NULL,
  key_check_salt BLOB NOT NULL CHECK (length(key_check_salt) = 32),
  key_check_authenticator BLOB NOT NULL CHECK (length(key_check_authenticator) = 32)
);

CREATE TABLE IF NOT EXISTS demo_instances (
  id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  catalog_version INTEGER NOT NULL DEFAULT 1 CHECK (catalog_version >= 1),
  CHECK (expires_at_ms > created_at_ms)
);

CREATE TABLE IF NOT EXISTS found_items (
  demo_instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  category TEXT NOT NULL,
  found_at TEXT NOT NULL,
  area TEXT NOT NULL,
  color TEXT NOT NULL,
  public_tags_json TEXT NOT NULL,
  public_description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'HELD', 'RETURNED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (demo_instance_id, id),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS found_items_instance_status_idx
  ON found_items(demo_instance_id, status);

CREATE TABLE IF NOT EXISTS item_evidence_slots (
  demo_instance_id TEXT NOT NULL,
  found_item_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('unique_mark', 'contents_or_accessory', 'identifier_suffix')),
  salt BLOB,
  digest BLOB,
  PRIMARY KEY (demo_instance_id, found_item_id, slot),
  FOREIGN KEY (demo_instance_id, found_item_id)
    REFERENCES found_items(demo_instance_id, id) ON DELETE CASCADE,
  CHECK ((salt IS NULL AND digest IS NULL) OR (salt IS NOT NULL AND digest IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS item_evidence_slots_item_idx
  ON item_evidence_slots(demo_instance_id, found_item_id);

CREATE TABLE IF NOT EXISTS lost_reports (
  demo_instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  category TEXT NOT NULL,
  time_from TEXT NOT NULL,
  time_to TEXT NOT NULL,
  area TEXT NOT NULL,
  color TEXT NOT NULL,
  public_tags_json TEXT NOT NULL,
  public_description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RESOLVED', 'ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (demo_instance_id, id),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS lost_reports_instance_owner_idx
  ON lost_reports(demo_instance_id, owner_actor_id);

CREATE TABLE IF NOT EXISTS claims (
  demo_instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  found_item_id TEXT NOT NULL,
  claimant_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'REJECTED', 'LOCKED',
    'APPROVED', 'PICKUP_READY', 'COLLECTED'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  evidence_eligible INTEGER NOT NULL DEFAULT 0 CHECK (evidence_eligible IN (0, 1)),
  reviewer_actor_id TEXT,
  pickup_pass_salt BLOB,
  pickup_pass_digest BLOB,
  pickup_pass_expires_at_ms INTEGER,
  pass_generation INTEGER NOT NULL DEFAULT 0 CHECK (pass_generation >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (demo_instance_id, id),
  FOREIGN KEY (demo_instance_id, report_id)
    REFERENCES lost_reports(demo_instance_id, id) ON DELETE CASCADE,
  FOREIGN KEY (demo_instance_id, found_item_id)
    REFERENCES found_items(demo_instance_id, id) ON DELETE RESTRICT,
  CHECK (
    (pickup_pass_salt IS NULL AND pickup_pass_digest IS NULL AND pickup_pass_expires_at_ms IS NULL)
    OR
    (pickup_pass_salt IS NOT NULL AND pickup_pass_digest IS NOT NULL AND pickup_pass_expires_at_ms IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS claims_report_idx
  ON claims(demo_instance_id, report_id);
CREATE INDEX IF NOT EXISTS claims_item_idx
  ON claims(demo_instance_id, found_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS claims_single_approved_item_idx
  ON claims(demo_instance_id, found_item_id)
  WHERE status IN ('APPROVED', 'PICKUP_READY');

CREATE TABLE IF NOT EXISTS audit_events (
  demo_instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('INSTANCE', 'REPORT', 'CLAIM')),
  resource_public_id TEXT,
  action TEXT NOT NULL CHECK (action IN (
    'DEMO_CREATED', 'REPORT_CREATED', 'REPORT_UPDATED', 'INVENTORY_UPDATED',
    'CLAIM_CREATED', 'CLAIM_UPDATED'
  )),
  actor_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'DENIED')),
  occurred_at_ms INTEGER NOT NULL,
  PRIMARY KEY (demo_instance_id, id),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS audit_events_instance_time_idx
  ON audit_events(demo_instance_id, occurred_at_ms, id);

CREATE TABLE IF NOT EXISTS idempotency_records (
  demo_instance_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  key_digest BLOB NOT NULL CHECK (length(key_digest) = 32),
  request_fingerprint_digest BLOB NOT NULL CHECK (length(request_fingerprint_digest) = 32),
  result_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (demo_instance_id, actor_id, action, key_digest),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idempotency_records_instance_idx
  ON idempotency_records(demo_instance_id);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  demo_instance_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  PRIMARY KEY (demo_instance_id, actor_id, action, window_start_ms),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_instance_idx
  ON rate_limit_buckets(demo_instance_id);

CREATE TABLE IF NOT EXISTS consumed_action_nonces (
  demo_instance_id TEXT NOT NULL,
  nonce_digest BLOB NOT NULL CHECK (length(nonce_digest) = 32),
  action TEXT NOT NULL,
  consumed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (demo_instance_id, nonce_digest),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS consumed_action_nonces_instance_idx
  ON consumed_action_nonces(demo_instance_id);
