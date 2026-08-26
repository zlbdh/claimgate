import type {
  CreateLostReportInput,
  LostReportRecord,
  RepositoryContext,
  UpdateLostReportInput,
} from "./repository-types";
import { DomainError } from "@/shared/domain-error";
import { assertReportTransition } from "@/features/claims/claim-state";
import { appendAuditEvent } from "./audit-repository";
import { activeInstance, immediate, parseStringArray, stateChanged } from "./repository-internal";

type ReportRow = {
  reportId: string;
  ownerActorId: string;
  category: string;
  timeFrom: string;
  timeTo: string;
  area: string;
  color: string;
  publicTagsJson: string;
  publicDescription: string;
  status: LostReportRecord["status"];
  version: number;
};

function toRecord(row: ReportRow): LostReportRecord {
  return {
    reportId: row.reportId,
    ownerActorId: row.ownerActorId,
    category: row.category,
    timeWindow: { from: row.timeFrom, to: row.timeTo },
    area: row.area,
    color: row.color,
    publicTags: parseStringArray(row.publicTagsJson),
    publicDescription: row.publicDescription,
    status: row.status,
    version: row.version,
  };
}

const REPORT_SELECT = `
  SELECT id AS reportId, owner_actor_id AS ownerActorId, category,
    time_from AS timeFrom, time_to AS timeTo, area, color,
    public_tags_json AS publicTagsJson, public_description AS publicDescription,
    status, version
  FROM lost_reports
`;

export function getLostReport(
  context: RepositoryContext,
  demoInstanceId: string,
  reportId: string,
): LostReportRecord {
  activeInstance(context, demoInstanceId);
  const row = context.database.prepare(`${REPORT_SELECT} WHERE demo_instance_id = ? AND id = ?`)
    .get(demoInstanceId, reportId) as ReportRow | undefined;
  if (!row) throw new DomainError("NOT_FOUND");
  return toRecord(row);
}

export function listLostReports(context: RepositoryContext, demoInstanceId: string): LostReportRecord[] {
  activeInstance(context, demoInstanceId);
  return (context.database.prepare(`${REPORT_SELECT} WHERE demo_instance_id = ? ORDER BY id`)
    .all(demoInstanceId) as ReportRow[]).map(toRecord);
}

export function createLostReport(
  context: RepositoryContext,
  input: CreateLostReportInput,
): LostReportRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const reportId = context.randomId();
    context.database.prepare(`
      INSERT INTO lost_reports (
        demo_instance_id, id, owner_actor_id, category, time_from, time_to,
        area, color, public_tags_json, public_description, status, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 1)
    `).run(
      input.demoInstanceId,
      reportId,
      input.ownerActorId,
      input.category,
      input.timeWindow.from,
      input.timeWindow.to,
      input.area,
      input.color,
      JSON.stringify(input.publicTags),
      input.publicDescription,
    );
    appendAuditEvent(context, input.demoInstanceId, {
      resourceType: "REPORT",
      resourcePublicId: reportId,
      action: "REPORT_CREATED",
      actorId: input.ownerActorId,
      result: "SUCCEEDED",
    });
    return getLostReport(context, input.demoInstanceId, reportId);
  });
}

export function updateLostReport(
  context: RepositoryContext,
  input: UpdateLostReportInput,
): LostReportRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const row = context.database.prepare(`${REPORT_SELECT} WHERE demo_instance_id = ? AND id = ?`)
      .get(input.demoInstanceId, input.reportId) as ReportRow | undefined;
    if (!row || row.version !== input.expectedVersion) stateChanged();
    const existing = toRecord(row);
    const next = { ...existing, ...input.patch, timeWindow: input.patch.timeWindow ?? existing.timeWindow };
    if (input.patch.status !== undefined) {
      assertReportTransition(existing.status, input.patch.status);
    }
    const result = context.database.prepare(`
      UPDATE lost_reports SET time_from = ?, time_to = ?, area = ?, color = ?,
        public_tags_json = ?, public_description = ?, status = ?, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND version = ?
    `).run(
      next.timeWindow.from,
      next.timeWindow.to,
      next.area,
      next.color,
      JSON.stringify(next.publicTags),
      next.publicDescription,
      next.status,
      input.demoInstanceId,
      input.reportId,
      input.expectedVersion,
    );
    if (result.changes !== 1) stateChanged();
    appendAuditEvent(context, input.demoInstanceId, {
      resourceType: "REPORT",
      resourcePublicId: input.reportId,
      action: "REPORT_UPDATED",
      actorId: input.actorId,
      result: "SUCCEEDED",
    });
    return getLostReport(context, input.demoInstanceId, input.reportId);
  });
}
