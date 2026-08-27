import { DomainError } from "@/shared/domain-error";
import { assertNoInternalInventoryIdentity, requireActor } from "./repository-internal";
import type { ClaimEvent, RepositoryContext } from "./repository-types";

type EventType = ClaimEvent["eventType"];

const EVENT_RESULT: Readonly<Record<EventType, ClaimEvent["result"]>> = Object.freeze({
  EVIDENCE_INSUFFICIENT: "INSUFFICIENT",
  EVIDENCE_ELIGIBLE: "ELIGIBLE",
  EVIDENCE_LOCKED: "LOCKED",
  UNLOCKED: "UNLOCKED",
  APPROVED: "APPROVED",
  STAFF_REJECTED: "REJECTED",
  COMPETING_REJECTED: "REJECTED",
  PASS_ISSUED: "ISSUED",
  PASS_REISSUED: "REISSUED",
  HANDOFF_COMPLETED: "COLLECTED",
});

export function appendClaimEvent(
  context: RepositoryContext,
  demoInstanceId: string,
  claimId: string,
  eventType: EventType,
  actorId: string,
): void {
  const actor = requireActor(actorId);
  if (
    ((eventType.startsWith("EVIDENCE_") || eventType.startsWith("PASS_"))
      && actor !== "claimant-demo")
    || (!(eventType.startsWith("EVIDENCE_") || eventType.startsWith("PASS_"))
      && actor !== "staff-demo")
  ) throw new DomainError("VALIDATION_FAILED");
  const event = { eventType, actorId: actor, result: EVENT_RESULT[eventType] };
  assertNoInternalInventoryIdentity(context, event, "VALIDATION_FAILED");
  context.database.prepare(`
    INSERT INTO claim_events (
      demo_instance_id, id, claim_id, event_type, actor_id, result, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    demoInstanceId,
    context.randomId(),
    claimId,
    event.eventType,
    event.actorId,
    event.result,
    context.now(),
  );
}

export function listClaimEvents(
  context: RepositoryContext,
  demoInstanceId: string,
  claimId: string,
  limit = 50,
): ClaimEvent[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new DomainError("VALIDATION_FAILED");
  }
  const events = context.database.prepare(`
    SELECT event_type AS eventType, actor_id AS actorId, result,
      occurred_at_ms AS occurredAtMs
    FROM claim_events
    WHERE demo_instance_id = ? AND claim_id = ?
    ORDER BY occurred_at_ms, id LIMIT ?
  `).all(demoInstanceId, claimId, limit) as ClaimEvent[];
  assertNoInternalInventoryIdentity(context, events, "CONFIGURATION_ERROR");
  return events;
}
