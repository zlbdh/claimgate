import { cloneStandardPickupBuffer } from "@/features/claims/standard-pickup-buffer";
import { DomainError } from "@/shared/domain-error";
import { appendClaimEvent } from "./claim-event-repository";
import {
  activeInstance, CLAIMANT_ACTOR_ID, immediate, requireActor,
  requireInteger, STAFF_ACTOR_ID, stateChanged,
} from "./repository-internal";
import type {
  CompletePickupHandoffInput, HandoffAck, IssuePickupPassInput,
  PickupPassAck, RepositoryContext, ServerInternalPickupContext,
} from "./repository-types";

type PickupRow = {
  claimantActorId: string;
  claimStatus: ServerInternalPickupContext["claimStatus"];
  claimVersion: number;
  salt: Buffer | null;
  digest: Buffer | null;
  expiresAtMs: number | null;
  consumedAtMs: number | null;
  generation: number;
  itemId: string;
  itemStatus: ServerInternalPickupContext["itemStatus"];
  itemVersion: number;
  reportId: string;
  reportStatus: ServerInternalPickupContext["reportStatus"];
  reportVersion: number;
  instanceExpiresAtMs: number;
};

const PICKUP_SELECT = `
  SELECT c.claimant_actor_id AS claimantActorId, c.status AS claimStatus,
    c.version AS claimVersion, c.pickup_pass_salt AS salt,
    c.pickup_pass_digest AS digest, c.pickup_pass_expires_at_ms AS expiresAtMs,
    c.pickup_pass_consumed_at_ms AS consumedAtMs, c.pass_generation AS generation,
    i.id AS itemId, i.status AS itemStatus, i.version AS itemVersion,
    r.id AS reportId, r.status AS reportStatus, r.version AS reportVersion,
    d.expires_at_ms AS instanceExpiresAtMs
  FROM claims c
  JOIN found_items i ON i.demo_instance_id = c.demo_instance_id AND i.id = c.found_item_id
  JOIN lost_reports r ON r.demo_instance_id = c.demo_instance_id AND r.id = c.report_id
  JOIN demo_instances d ON d.id = c.demo_instance_id
  WHERE c.demo_instance_id = ? AND c.id = ?
`;

function readRow(context: RepositoryContext, instanceId: string, claimId: string): PickupRow {
  const row = context.database.prepare(PICKUP_SELECT).get(instanceId, claimId) as PickupRow | undefined;
  if (!row) throw new DomainError("NOT_FOUND");
  return row;
}

function safeBuffers(row: PickupRow): { salt: Buffer | null; digest: Buffer | null } {
  if (row.salt === null || row.digest === null) {
    if (row.salt !== null || row.digest !== null) throw new DomainError("CONFIGURATION_ERROR");
    return { salt: null, digest: null };
  }
  return {
    salt: cloneStandardPickupBuffer(row.salt, 32),
    digest: cloneStandardPickupBuffer(row.digest, 32),
  };
}

export function getServerInternalPickupContext(
  context: RepositoryContext,
  demoInstanceId: string,
  claimId: string,
): ServerInternalPickupContext {
  activeInstance(context, demoInstanceId);
  const row = readRow(context, demoInstanceId, claimId);
  const buffers = safeBuffers(row);
  return Object.freeze({
    claimantActorId: row.claimantActorId,
    claimStatus: row.claimStatus,
    claimVersion: row.claimVersion,
    salt: buffers.salt,
    digest: buffers.digest,
    expiresAtMs: row.expiresAtMs,
    consumedAtMs: row.consumedAtMs,
    generation: row.generation,
    itemStatus: row.itemStatus,
    itemVersion: row.itemVersion,
    reportStatus: row.reportStatus,
    reportVersion: row.reportVersion,
    instanceExpiresAtMs: row.instanceExpiresAtMs,
  });
}

export function issuePickupPass(
  context: RepositoryContext,
  input: IssuePickupPassInput,
): PickupPassAck {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    if (requireActor(input.claimantActorId) !== CLAIMANT_ACTOR_ID) throw new DomainError("FORBIDDEN");
    requireInteger(input.expectedClaimVersion, true);
    requireInteger(input.generation, true);
    requireInteger(input.expiresAtMs, true);
    const salt = cloneStandardPickupBuffer(input.salt, 32);
    const digest = cloneStandardPickupBuffer(input.digest, 32);
    const row = readRow(context, input.demoInstanceId, input.claimId);
    if (row.claimantActorId !== input.claimantActorId) throw new DomainError("NOT_FOUND");
    if (row.claimVersion !== input.expectedClaimVersion) stateChanged();
    if (row.itemStatus !== "HELD") throw new DomainError("ITEM_UNAVAILABLE");
    if (row.reportStatus !== "PUBLISHED") throw new DomainError("INVALID_STATE_TRANSITION");
    const now = context.now();
    if (input.expiresAtMs <= now || input.expiresAtMs > row.instanceExpiresAtMs) {
      throw new DomainError("VALIDATION_FAILED");
    }
    const initial = input.action === "pickup_issue";
    if (
      initial
        ? row.claimStatus !== "APPROVED" || row.generation !== 0 || input.generation !== 1
        : input.action !== "pickup_reissue" || row.claimStatus !== "PICKUP_READY"
          || row.consumedAtMs !== null || input.generation !== row.generation + 1
    ) throw new DomainError("INVALID_STATE_TRANSITION");
    const result = context.database.prepare(`
      UPDATE claims SET status = 'PICKUP_READY', pickup_pass_salt = ?,
        pickup_pass_digest = ?, pickup_pass_expires_at_ms = ?,
        pickup_pass_consumed_at_ms = NULL, pass_generation = ?, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND version = ?
        AND claimant_actor_id = ? AND status = ? AND pass_generation = ?
        AND pickup_pass_consumed_at_ms IS NULL
    `).run(
      salt, digest, BigInt(input.expiresAtMs), input.generation,
      input.demoInstanceId, input.claimId, input.expectedClaimVersion,
      input.claimantActorId, initial ? "APPROVED" : "PICKUP_READY", row.generation,
    );
    if (result.changes !== 1) stateChanged();
    appendClaimEvent(
      context, input.demoInstanceId, input.claimId,
      initial ? "PASS_ISSUED" : "PASS_REISSUED", input.claimantActorId,
    );
    return Object.freeze({
      kind: "pickup_pass_ack", claimId: input.claimId, status: "PICKUP_READY",
      claimVersion: input.expectedClaimVersion + 1,
      generation: input.generation, expiresAtMs: input.expiresAtMs,
    });
  });
}

export function completePickupHandoff(
  context: RepositoryContext,
  input: CompletePickupHandoffInput,
): HandoffAck {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    if (requireActor(input.staffActorId) !== STAFF_ACTOR_ID) throw new DomainError("FORBIDDEN");
    for (const value of [input.expectedClaimVersion, input.expectedItemVersion,
      input.expectedReportVersion, input.expectedGeneration]) requireInteger(value, true);
    const row = readRow(context, input.demoInstanceId, input.claimId);
    if (row.claimVersion !== input.expectedClaimVersion
      || row.itemVersion !== input.expectedItemVersion
      || row.reportVersion !== input.expectedReportVersion
      || row.generation !== input.expectedGeneration) stateChanged();
    const now = context.now();
    if (row.claimStatus !== "PICKUP_READY" || row.consumedAtMs !== null) {
      throw new DomainError("INVALID_STATE_TRANSITION");
    }
    if (row.expiresAtMs === null || row.expiresAtMs <= now) throw new DomainError("FORBIDDEN");
    if (row.itemStatus !== "HELD") throw new DomainError("ITEM_UNAVAILABLE");
    if (row.reportStatus !== "PUBLISHED") throw new DomainError("INVALID_STATE_TRANSITION");

    if (context.database.prepare(`
      UPDATE claims SET status = 'COLLECTED', pickup_pass_consumed_at_ms = ?, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND status = 'PICKUP_READY'
        AND pickup_pass_consumed_at_ms IS NULL AND pass_generation = ? AND version = ?
    `).run(BigInt(now), input.demoInstanceId, input.claimId, input.expectedGeneration,
      input.expectedClaimVersion).changes !== 1) stateChanged();
    if (context.database.prepare(`
      UPDATE found_items SET status = 'RETURNED', version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND status = 'HELD' AND version = ?
    `).run(input.demoInstanceId, row.itemId, input.expectedItemVersion).changes !== 1) stateChanged();
    if (context.database.prepare(`
      UPDATE lost_reports SET status = 'RESOLVED', version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND status = 'PUBLISHED' AND version = ?
    `).run(input.demoInstanceId, row.reportId, input.expectedReportVersion).changes !== 1) stateChanged();
    if (context.database.prepare(`
      UPDATE demo_instances SET catalog_version = catalog_version + 1
      WHERE id = ? AND expires_at_ms > ?
    `).run(input.demoInstanceId, now).changes !== 1) stateChanged();
    appendClaimEvent(context, input.demoInstanceId, input.claimId, "HANDOFF_COMPLETED", input.staffActorId);
    return Object.freeze({
      kind: "handoff_ack", claimId: input.claimId, completion: "COLLECTED",
      claimStatus: "COLLECTED", claimVersion: input.expectedClaimVersion + 1,
      itemStatus: "RETURNED", itemVersion: input.expectedItemVersion + 1,
      reportStatus: "RESOLVED", reportVersion: input.expectedReportVersion + 1,
      generation: input.expectedGeneration,
    });
  });
}
