import type { AuditEvent, RepositoryContext } from "./repository-types";

export function appendAuditEvent(
  context: RepositoryContext,
  demoInstanceId: string,
  event: Omit<AuditEvent, "auditEventId" | "occurredAtMs">,
): void {
  context.database.prepare(`
    INSERT INTO audit_events (
      demo_instance_id, id, resource_type, resource_public_id,
      action, actor_id, result, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    demoInstanceId,
    context.randomId(),
    event.resourceType,
    event.resourcePublicId,
    event.action,
    event.actorId,
    event.result,
    context.now(),
  );
}

export function listAuditEvents(context: RepositoryContext, demoInstanceId: string): AuditEvent[] {
  return context.database.prepare(`
    SELECT id AS auditEventId, resource_type AS resourceType,
      resource_public_id AS resourcePublicId, action, actor_id AS actorId,
      result, occurred_at_ms AS occurredAtMs
    FROM audit_events WHERE demo_instance_id = ?
    ORDER BY occurred_at_ms, id
  `).all(demoInstanceId) as AuditEvent[];
}
