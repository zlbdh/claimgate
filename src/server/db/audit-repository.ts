import type { AuditEvent, RepositoryContext } from "./repository-types";
import { DEMO_IDENTITIES, type DemoUserId } from "@/shared/demo-identity";
import { assertNoInternalInventoryIdentity, requireActor } from "./repository-internal";

type AuditAction = AuditEvent["action"];

function appendAuditEvent(
  context: RepositoryContext,
  demoInstanceId: string,
  event: {
    resourceType: AuditEvent["resourceType"];
    reportId: string | null;
    claimId: string | null;
    action: AuditAction;
    actorId: string;
    result: AuditEvent["result"];
  },
): void {
  requireActor(event.actorId, true);
  assertNoInternalInventoryIdentity(context, event, "VALIDATION_FAILED");
  context.database.prepare(`
    INSERT INTO audit_events (
      demo_instance_id, id, resource_type, report_id, claim_id,
      action, actor_id, result, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    demoInstanceId,
    context.randomId(),
    event.resourceType,
    event.reportId,
    event.claimId,
    event.action,
    event.actorId,
    event.result,
    context.now(),
  );
}

export function appendInstanceAudit(
  context: RepositoryContext,
  demoInstanceId: string,
  action: "DEMO_CREATED" | "INVENTORY_UPDATED",
  actorId: "system" | typeof DEMO_IDENTITIES.STAFF.userId,
): void {
  appendAuditEvent(context, demoInstanceId, {
    resourceType: "INSTANCE", reportId: null, claimId: null,
    action, actorId, result: "SUCCEEDED",
  });
}

export function appendReportAudit(
  context: RepositoryContext,
  demoInstanceId: string,
  reportId: string,
  action: "REPORT_CREATED" | "REPORT_UPDATED",
  actorId: DemoUserId,
): void {
  appendAuditEvent(context, demoInstanceId, {
    resourceType: "REPORT", reportId, claimId: null,
    action, actorId, result: "SUCCEEDED",
  });
}

export function appendClaimAudit(
  context: RepositoryContext,
  demoInstanceId: string,
  claimId: string,
  action: "CLAIM_CREATED" | "CLAIM_UPDATED",
  actorId: DemoUserId,
): void {
  appendAuditEvent(context, demoInstanceId, {
    resourceType: "CLAIM", reportId: null, claimId,
    action, actorId, result: "SUCCEEDED",
  });
}

export function listAuditEvents(context: RepositoryContext, demoInstanceId: string): AuditEvent[] {
  const events = context.database.prepare(`
    SELECT id AS auditEventId, resource_type AS resourceType,
      CASE WHEN resource_type = 'INSTANCE' THEN demo_instance_id
        ELSE COALESCE(report_id, claim_id) END AS resourcePublicId,
      action, actor_id AS actorId,
      result, occurred_at_ms AS occurredAtMs
    FROM audit_events WHERE demo_instance_id = ?
    ORDER BY occurred_at_ms, id
  `).all(demoInstanceId) as AuditEvent[];
  assertNoInternalInventoryIdentity(context, events, "CONFIGURATION_ERROR");
  return events;
}
