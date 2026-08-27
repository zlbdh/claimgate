CREATE TABLE IF NOT EXISTS database_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  database_uuid TEXT NOT NULL,
  key_check_salt BLOB NOT NULL CHECK (typeof(key_check_salt) = 'blob' AND length(key_check_salt) = 32),
  key_check_authenticator BLOB NOT NULL CHECK (
    typeof(key_check_authenticator) = 'blob' AND length(key_check_authenticator) = 32
  )
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

CREATE TRIGGER IF NOT EXISTS demo_instances_id_not_found_item_id_global_insert
BEFORE INSERT ON demo_instances
WHEN EXISTS (
  SELECT 1 FROM found_items
  WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'demo instance id must not be an inventory id');
END;

CREATE TRIGGER IF NOT EXISTS demo_instances_id_not_found_item_id_global_update
BEFORE UPDATE OF id ON demo_instances
WHEN EXISTS (
  SELECT 1 FROM found_items
  WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'demo instance id must not be an inventory id');
END;

CREATE TRIGGER IF NOT EXISTS found_items_id_not_demo_instance_id_global_insert
BEFORE INSERT ON found_items
WHEN EXISTS (
  SELECT 1 FROM demo_instances
  WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'inventory id must not be a demo instance id');
END;

CREATE TRIGGER IF NOT EXISTS found_items_id_not_demo_instance_id_global_update
BEFORE UPDATE OF id ON found_items
WHEN EXISTS (
  SELECT 1 FROM demo_instances
  WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'inventory id must not be a demo instance id');
END;

CREATE TABLE IF NOT EXISTS item_evidence_slots (
  demo_instance_id TEXT NOT NULL,
  found_item_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('unique_mark', 'contents_or_accessory', 'identifier_suffix')),
  salt BLOB,
  digest BLOB,
  PRIMARY KEY (demo_instance_id, found_item_id, slot),
  FOREIGN KEY (demo_instance_id, found_item_id)
    REFERENCES found_items(demo_instance_id, id) ON DELETE CASCADE,
  CHECK (
    (salt IS NULL AND digest IS NULL)
    OR
    (
      typeof(salt) = 'blob' AND length(salt) = 16
      AND typeof(digest) = 'blob' AND length(digest) = 32
    )
  )
);

CREATE INDEX IF NOT EXISTS item_evidence_slots_item_idx
  ON item_evidence_slots(demo_instance_id, found_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS item_evidence_slots_salt_unique_idx
  ON item_evidence_slots(salt)
  WHERE salt IS NOT NULL;

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
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 3
  ),
  evidence_eligible INTEGER NOT NULL DEFAULT 0 CHECK (evidence_eligible IN (0, 1)),
  reviewer_actor_id TEXT,
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL OR rejection_reason IN (
      'STAFF_REJECTED', 'ITEM_HELD_BY_ANOTHER_CLAIM'
    )
  ),
  unlock_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(unlock_count) = 'integer' AND unlock_count BETWEEN 0 AND 1
  ),
  pickup_pass_salt BLOB,
  pickup_pass_digest BLOB,
  pickup_pass_expires_at_ms,
  pass_generation INTEGER NOT NULL DEFAULT 0 CHECK (pass_generation >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (demo_instance_id, id),
  FOREIGN KEY (demo_instance_id, report_id)
    REFERENCES lost_reports(demo_instance_id, id) ON DELETE CASCADE,
  FOREIGN KEY (demo_instance_id, found_item_id)
    REFERENCES found_items(demo_instance_id, id) ON DELETE RESTRICT,
  CHECK (
    typeof(pass_generation) = 'integer'
    AND pass_generation >= 0
    AND pass_generation <= 9007199254740991
  ),
  CHECK (
    (
      pickup_pass_salt IS NULL AND pickup_pass_digest IS NULL
      AND pickup_pass_expires_at_ms IS NULL AND pass_generation = 0
    )
    OR
    (
      typeof(pickup_pass_salt) = 'blob' AND length(pickup_pass_salt) = 32
      AND typeof(pickup_pass_digest) = 'blob' AND length(pickup_pass_digest) = 32
      AND typeof(pickup_pass_expires_at_ms) = 'integer'
      AND pickup_pass_expires_at_ms > 0
      AND pickup_pass_expires_at_ms <= 9007199254740991
      AND pass_generation > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS claims_report_idx
  ON claims(demo_instance_id, report_id);
CREATE INDEX IF NOT EXISTS claims_item_idx
  ON claims(demo_instance_id, found_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS claims_single_winner_item_idx
  ON claims(demo_instance_id, found_item_id)
  WHERE status IN ('APPROVED', 'PICKUP_READY', 'COLLECTED');

CREATE TRIGGER IF NOT EXISTS claims_v5_invariants_insert
BEFORE INSERT ON claims
WHEN COALESCE((
  typeof(NEW.attempts) = 'integer' AND NEW.attempts BETWEEN 0 AND 3
  AND typeof(NEW.evidence_eligible) = 'integer' AND NEW.evidence_eligible IN (0, 1)
  AND typeof(NEW.unlock_count) = 'integer' AND NEW.unlock_count BETWEEN 0 AND 1
  AND (NEW.reviewer_actor_id IS NULL OR NEW.reviewer_actor_id = 'staff-demo')
  AND (
    (NEW.status = 'EVIDENCE_REQUIRED' AND NEW.attempts BETWEEN 0 AND 2
      AND NEW.evidence_eligible = 0 AND NEW.reviewer_actor_id IS NULL
      AND NEW.rejection_reason IS NULL)
    OR (NEW.status = 'LOCKED' AND NEW.attempts = 3
      AND NEW.evidence_eligible = 0 AND NEW.reviewer_actor_id IS NULL
      AND NEW.rejection_reason IS NULL)
    OR (NEW.status = 'UNDER_REVIEW' AND NEW.attempts BETWEEN 0 AND 2
      AND NEW.evidence_eligible = 1 AND NEW.reviewer_actor_id IS NULL
      AND NEW.rejection_reason IS NULL)
    OR (NEW.status IN ('APPROVED', 'PICKUP_READY', 'COLLECTED')
      AND NEW.attempts BETWEEN 0 AND 2 AND NEW.evidence_eligible = 1
      AND NEW.reviewer_actor_id = 'staff-demo' AND NEW.rejection_reason IS NULL)
    OR (NEW.status = 'REJECTED' AND NEW.rejection_reason = 'STAFF_REJECTED'
      AND NEW.attempts BETWEEN 0 AND 2 AND NEW.evidence_eligible = 1
      AND NEW.reviewer_actor_id = 'staff-demo')
    OR (NEW.status = 'REJECTED'
      AND NEW.rejection_reason = 'ITEM_HELD_BY_ANOTHER_CLAIM'
      AND NEW.reviewer_actor_id IS NULL
      AND ((NEW.evidence_eligible = 0 AND NEW.attempts BETWEEN 0 AND 3)
        OR (NEW.evidence_eligible = 1 AND NEW.attempts BETWEEN 0 AND 2)))
  )
), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid claim v5 state');
END;

CREATE TRIGGER IF NOT EXISTS claims_v5_invariants_update
BEFORE UPDATE ON claims
WHEN COALESCE((
  typeof(NEW.attempts) = 'integer' AND NEW.attempts BETWEEN 0 AND 3
  AND typeof(NEW.evidence_eligible) = 'integer' AND NEW.evidence_eligible IN (0, 1)
  AND typeof(NEW.unlock_count) = 'integer' AND NEW.unlock_count BETWEEN 0 AND 1
  AND (NEW.reviewer_actor_id IS NULL OR NEW.reviewer_actor_id = 'staff-demo')
  AND (
    (NEW.status = 'EVIDENCE_REQUIRED' AND NEW.attempts BETWEEN 0 AND 2
      AND NEW.evidence_eligible = 0 AND NEW.reviewer_actor_id IS NULL
      AND NEW.rejection_reason IS NULL)
    OR (NEW.status = 'LOCKED' AND NEW.attempts = 3
      AND NEW.evidence_eligible = 0 AND NEW.reviewer_actor_id IS NULL
      AND NEW.rejection_reason IS NULL)
    OR (NEW.status = 'UNDER_REVIEW' AND NEW.attempts BETWEEN 0 AND 2
      AND NEW.evidence_eligible = 1 AND NEW.reviewer_actor_id IS NULL
      AND NEW.rejection_reason IS NULL)
    OR (NEW.status IN ('APPROVED', 'PICKUP_READY', 'COLLECTED')
      AND NEW.attempts BETWEEN 0 AND 2 AND NEW.evidence_eligible = 1
      AND NEW.reviewer_actor_id = 'staff-demo' AND NEW.rejection_reason IS NULL)
    OR (NEW.status = 'REJECTED' AND NEW.rejection_reason = 'STAFF_REJECTED'
      AND NEW.attempts BETWEEN 0 AND 2 AND NEW.evidence_eligible = 1
      AND NEW.reviewer_actor_id = 'staff-demo')
    OR (NEW.status = 'REJECTED'
      AND NEW.rejection_reason = 'ITEM_HELD_BY_ANOTHER_CLAIM'
      AND NEW.reviewer_actor_id IS NULL
      AND ((NEW.evidence_eligible = 0 AND NEW.attempts BETWEEN 0 AND 3)
        OR (NEW.evidence_eligible = 1 AND NEW.attempts BETWEEN 0 AND 2)))
  )
), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid claim v5 state');
END;

CREATE TRIGGER IF NOT EXISTS claims_v5_transition_update
BEFORE UPDATE OF status ON claims
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'EVIDENCE_REQUIRED' AND NEW.status IN ('UNDER_REVIEW', 'LOCKED', 'REJECTED'))
  OR (OLD.status = 'UNDER_REVIEW' AND NEW.status IN ('APPROVED', 'REJECTED'))
  OR (OLD.status = 'LOCKED' AND NEW.status IN ('EVIDENCE_REQUIRED', 'REJECTED'))
  OR (OLD.status = 'APPROVED' AND NEW.status = 'PICKUP_READY')
  OR (OLD.status = 'PICKUP_READY' AND NEW.status = 'COLLECTED')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid claim v5 transition');
END;

CREATE TRIGGER IF NOT EXISTS claims_v5_unlock_update
BEFORE UPDATE ON claims
WHEN NEW.unlock_count < OLD.unlock_count
  OR NEW.unlock_count > OLD.unlock_count + 1
  OR (NEW.unlock_count <> OLD.unlock_count AND NOT (
    OLD.unlock_count = 0 AND NEW.unlock_count = 1
    AND OLD.status = 'LOCKED' AND OLD.attempts = 3
    AND NEW.status = 'EVIDENCE_REQUIRED' AND NEW.attempts = 0
  ))
  OR (OLD.status = 'LOCKED' AND NEW.status = 'EVIDENCE_REQUIRED' AND NOT (
    OLD.unlock_count = 0 AND NEW.unlock_count = 1
    AND OLD.attempts = 3 AND NEW.attempts = 0
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid claim unlock transition');
END;

CREATE TABLE IF NOT EXISTS claim_events (
  demo_instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'EVIDENCE_INSUFFICIENT', 'EVIDENCE_ELIGIBLE', 'EVIDENCE_LOCKED',
    'UNLOCKED', 'APPROVED', 'STAFF_REJECTED', 'COMPETING_REJECTED'
  )),
  actor_id TEXT NOT NULL CHECK (actor_id IN ('claimant-demo', 'staff-demo')),
  result TEXT NOT NULL CHECK (result IN (
    'INSUFFICIENT', 'ELIGIBLE', 'LOCKED', 'UNLOCKED', 'APPROVED', 'REJECTED'
  )),
  occurred_at_ms INTEGER NOT NULL CHECK (
    typeof(occurred_at_ms) = 'integer'
    AND occurred_at_ms BETWEEN 0 AND 9007199254740991
  ),
  PRIMARY KEY (demo_instance_id, id),
  FOREIGN KEY (demo_instance_id, claim_id)
    REFERENCES claims(demo_instance_id, id) ON DELETE CASCADE,
  CHECK (
    (event_type = 'EVIDENCE_INSUFFICIENT' AND actor_id = 'claimant-demo' AND result = 'INSUFFICIENT')
    OR (event_type = 'EVIDENCE_ELIGIBLE' AND actor_id = 'claimant-demo' AND result = 'ELIGIBLE')
    OR (event_type = 'EVIDENCE_LOCKED' AND actor_id = 'claimant-demo' AND result = 'LOCKED')
    OR (event_type = 'UNLOCKED' AND actor_id = 'staff-demo' AND result = 'UNLOCKED')
    OR (event_type = 'APPROVED' AND actor_id = 'staff-demo' AND result = 'APPROVED')
    OR (event_type IN ('STAFF_REJECTED', 'COMPETING_REJECTED')
      AND actor_id = 'staff-demo' AND result = 'REJECTED')
  )
);

CREATE INDEX IF NOT EXISTS claim_events_claim_time_idx
  ON claim_events(demo_instance_id, claim_id, occurred_at_ms, id);

CREATE TABLE IF NOT EXISTS audit_events (
  demo_instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('INSTANCE', 'REPORT', 'CLAIM')),
  report_id TEXT,
  claim_id TEXT,
  action TEXT NOT NULL CHECK (action IN (
    'DEMO_CREATED', 'REPORT_CREATED', 'REPORT_UPDATED', 'INVENTORY_UPDATED',
    'CLAIM_CREATED', 'CLAIM_UPDATED'
  )),
  actor_id TEXT NOT NULL CHECK (actor_id IN ('system', 'claimant-demo', 'staff-demo')),
  result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'DENIED')),
  occurred_at_ms INTEGER NOT NULL,
  PRIMARY KEY (demo_instance_id, id),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (demo_instance_id, report_id)
    REFERENCES lost_reports(demo_instance_id, id) ON DELETE CASCADE,
  FOREIGN KEY (demo_instance_id, claim_id)
    REFERENCES claims(demo_instance_id, id) ON DELETE CASCADE,
  CHECK (
    (resource_type = 'INSTANCE' AND report_id IS NULL AND claim_id IS NULL
      AND action IN ('DEMO_CREATED', 'INVENTORY_UPDATED'))
    OR
    (resource_type = 'REPORT' AND report_id IS NOT NULL AND claim_id IS NULL
      AND action IN ('REPORT_CREATED', 'REPORT_UPDATED'))
    OR
    (resource_type = 'CLAIM' AND report_id IS NULL AND claim_id IS NOT NULL
      AND action IN ('CLAIM_CREATED', 'CLAIM_UPDATED'))
  )
);

CREATE INDEX IF NOT EXISTS audit_events_instance_time_idx
  ON audit_events(demo_instance_id, occurred_at_ms, id);
CREATE INDEX IF NOT EXISTS audit_events_report_idx
  ON audit_events(demo_instance_id, report_id, occurred_at_ms);
CREATE INDEX IF NOT EXISTS audit_events_claim_idx
  ON audit_events(demo_instance_id, claim_id, occurred_at_ms);

CREATE TRIGGER IF NOT EXISTS audit_events_actor_not_inventory_id_global_insert
BEFORE INSERT ON audit_events
WHEN EXISTS (
  SELECT 1 FROM found_items
  WHERE id = NEW.actor_id
)
BEGIN
  SELECT RAISE(ABORT, 'audit actor must not be an inventory id');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_actor_not_inventory_id_global_update
BEFORE UPDATE OF actor_id ON audit_events
WHEN EXISTS (
  SELECT 1 FROM found_items
  WHERE id = NEW.actor_id
)
BEGIN
  SELECT RAISE(ABORT, 'audit actor must not be an inventory id');
END;

CREATE TRIGGER IF NOT EXISTS found_items_id_not_audit_actor_global_insert
BEFORE INSERT ON found_items
WHEN EXISTS (
  SELECT 1 FROM audit_events
  WHERE actor_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'inventory id must not be an audit actor');
END;

CREATE TRIGGER IF NOT EXISTS found_items_id_not_audit_actor_global_update
BEFORE UPDATE OF id ON found_items
WHEN EXISTS (
  SELECT 1 FROM audit_events
  WHERE actor_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'inventory id must not be an audit actor');
END;

CREATE TABLE IF NOT EXISTS idempotency_records (
  demo_instance_id TEXT NOT NULL,
  actor_id TEXT NOT NULL CHECK (actor_id IN ('claimant-demo', 'staff-demo')),
  action TEXT NOT NULL CHECK (action IN (
    'draft_create', 'draft_update', 'claim_stage',
    'evidence_submit', 'claim_approve', 'claim_reject', 'claim_unlock'
  )),
  key_digest BLOB NOT NULL CHECK (typeof(key_digest) = 'blob' AND length(key_digest) = 32),
  request_fingerprint_digest BLOB NOT NULL CHECK (
    typeof(request_fingerprint_digest) = 'blob' AND length(request_fingerprint_digest) = 32
  ),
  result_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (demo_instance_id, actor_id, action, key_digest),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idempotency_records_instance_idx
  ON idempotency_records(demo_instance_id);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  demo_instance_id TEXT NOT NULL,
  actor_id TEXT NOT NULL CHECK (actor_id IN ('claimant-demo', 'staff-demo')),
  action TEXT NOT NULL CHECK (action IN (
    'role_switch', 'draft_create', 'draft_update', 'report_publish',
    'report_archive', 'claim_stage', 'evidence_submit', 'claim_approve', 'claim_reject',
    'claim_unlock', 'pickup_issue', 'pickup_reissue', 'handoff', 'match_find'
  )),
  window_start_ms INTEGER NOT NULL CHECK (typeof(window_start_ms) = 'integer' AND window_start_ms >= 0),
  request_count INTEGER NOT NULL CHECK (
    typeof(request_count) = 'integer' AND request_count >= 1 AND request_count <= 1000
  ),
  PRIMARY KEY (demo_instance_id, actor_id, action, window_start_ms),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_instance_idx
  ON rate_limit_buckets(demo_instance_id);

CREATE TABLE IF NOT EXISTS rate_limit_high_water (
  demo_instance_id TEXT NOT NULL,
  actor_id TEXT NOT NULL CHECK (actor_id IN ('claimant-demo', 'staff-demo')),
  action TEXT NOT NULL CHECK (action IN (
    'role_switch', 'draft_create', 'draft_update', 'report_publish',
    'report_archive', 'claim_stage', 'evidence_submit', 'claim_approve', 'claim_reject',
    'claim_unlock', 'pickup_issue', 'pickup_reissue', 'handoff', 'match_find'
  )),
  high_water_time_ms INTEGER NOT NULL CHECK (
    typeof(high_water_time_ms) = 'integer' AND high_water_time_ms >= 0
    AND high_water_time_ms <= 9007199254740991
  ),
  limit_value INTEGER NOT NULL CHECK (limit_value BETWEEN 1 AND 1000),
  window_ms INTEGER NOT NULL CHECK (window_ms BETWEEN 1 AND 86400000),
  PRIMARY KEY (demo_instance_id, actor_id, action),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS consumed_action_nonces (
  demo_instance_id TEXT NOT NULL,
  nonce_digest BLOB NOT NULL CHECK (typeof(nonce_digest) = 'blob' AND length(nonce_digest) = 32),
  action TEXT NOT NULL,
  consumed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (demo_instance_id, nonce_digest),
  FOREIGN KEY (demo_instance_id) REFERENCES demo_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS consumed_action_nonces_instance_idx
  ON consumed_action_nonces(demo_instance_id);

CREATE TABLE IF NOT EXISTS application_rate_limit_buckets (
  scope TEXT NOT NULL CHECK (scope = 'public-demo-entry'),
  action TEXT NOT NULL CHECK (action = 'demo_start'),
  window_start_ms INTEGER NOT NULL CHECK (
    typeof(window_start_ms) = 'integer' AND window_start_ms >= 0
    AND window_start_ms <= 9007199254740991
  ),
  request_count INTEGER NOT NULL CHECK (
    typeof(request_count) = 'integer' AND request_count >= 1 AND request_count <= 1000
  ),
  PRIMARY KEY (scope, action, window_start_ms)
);

CREATE TABLE IF NOT EXISTS application_rate_limit_high_water (
  scope TEXT NOT NULL CHECK (scope = 'public-demo-entry'),
  action TEXT NOT NULL CHECK (action = 'demo_start'),
  high_water_time_ms INTEGER NOT NULL CHECK (
    typeof(high_water_time_ms) = 'integer' AND high_water_time_ms >= 0
    AND high_water_time_ms <= 9007199254740991
  ),
  limit_value INTEGER NOT NULL CHECK (
    typeof(limit_value) = 'integer' AND limit_value = 30
  ),
  window_ms INTEGER NOT NULL CHECK (
    typeof(window_ms) = 'integer' AND window_ms = 60000
  ),
  PRIMARY KEY (scope, action)
);
