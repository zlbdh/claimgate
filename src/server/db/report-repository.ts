import type {
  CreateLostReportInput,
  LostReportRecord,
  RepositoryContext,
  TransitionLostReportInput,
  UpdateLostReportInput,
} from "./repository-types";
import { DomainError } from "@/shared/domain-error";
import { assertReportTransition } from "@/features/claims/claim-state";
import { appendReportAudit } from "./audit-repository";
import {
  activeInstance,
  assertNoInternalInventoryId,
  immediate,
  parseStringArray,
  requireActor,
  requirePatchKeys,
  stateChanged,
  validatePublicTags,
} from "./repository-internal";

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

function toPublicRecord(
  context: RepositoryContext,
  demoInstanceId: string,
  row: ReportRow,
): LostReportRecord {
  const record = toRecord(row);
  assertNoInternalInventoryId(context, demoInstanceId, record, "CONFIGURATION_ERROR");
  return record;
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
  return toPublicRecord(context, demoInstanceId, row);
}

export function listLostReports(context: RepositoryContext, demoInstanceId: string): LostReportRecord[] {
  activeInstance(context, demoInstanceId);
  return (context.database.prepare(`${REPORT_SELECT} WHERE demo_instance_id = ? ORDER BY id`)
    .all(demoInstanceId) as ReportRow[]).map((row) => toPublicRecord(context, demoInstanceId, row));
}

export function createLostReport(
  context: RepositoryContext,
  input: CreateLostReportInput,
): LostReportRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const ownerActorId = requireActor(input.ownerActorId);
    if (ownerActorId !== "claimant-demo") throw new DomainError("VALIDATION_FAILED");
    validatePublicTags(input.publicTags, "VALIDATION_FAILED");
    assertNoInternalInventoryId(context, input.demoInstanceId, input, "VALIDATION_FAILED");
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
    appendReportAudit(context, input.demoInstanceId, reportId, "REPORT_CREATED", ownerActorId);
    return getLostReport(context, input.demoInstanceId, reportId);
  });
}

export function updateLostReport(
  context: RepositoryContext,
  input: UpdateLostReportInput,
): LostReportRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const actorId = requireActor(input.actorId);
    requirePatchKeys(input.patch, ["area", "color", "publicTags", "publicDescription", "timeWindow"]);
    if (input.patch.publicTags !== undefined) {
      validatePublicTags(input.patch.publicTags, "VALIDATION_FAILED");
    }
    assertNoInternalInventoryId(context, input.demoInstanceId, input.patch, "VALIDATION_FAILED");
    const row = context.database.prepare(`${REPORT_SELECT} WHERE demo_instance_id = ? AND id = ?`)
      .get(input.demoInstanceId, input.reportId) as ReportRow | undefined;
    if (!row || row.version !== input.expectedVersion) stateChanged();
    const existing = toRecord(row);
    const next = { ...existing, ...input.patch, timeWindow: input.patch.timeWindow ?? existing.timeWindow };
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
    appendReportAudit(context, input.demoInstanceId, input.reportId, "REPORT_UPDATED", actorId);
    return getLostReport(context, input.demoInstanceId, input.reportId);
  });
}

function transitionLostReport(
  context: RepositoryContext,
  input: TransitionLostReportInput,
  targetStatus: "PUBLISHED" | "ARCHIVED",
): LostReportRecord {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const actorId = requireActor(input.actorId);
    const row = context.database.prepare(`${REPORT_SELECT} WHERE demo_instance_id = ? AND id = ?`)
      .get(input.demoInstanceId, input.reportId) as ReportRow | undefined;
    if (!row || row.version !== input.expectedVersion) stateChanged();
    assertReportTransition(row.status, targetStatus);
    const result = context.database.prepare(`
      UPDATE lost_reports SET status = ?, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND version = ?
    `).run(targetStatus, input.demoInstanceId, input.reportId, input.expectedVersion);
    if (result.changes !== 1) stateChanged();
    appendReportAudit(context, input.demoInstanceId, input.reportId, "REPORT_UPDATED", actorId);
    return getLostReport(context, input.demoInstanceId, input.reportId);
  });
}

export function publishLostReport(
  context: RepositoryContext,
  input: TransitionLostReportInput,
): LostReportRecord {
  return transitionLostReport(context, input, "PUBLISHED");
}

export function archiveLostReport(
  context: RepositoryContext,
  input: TransitionLostReportInput,
): LostReportRecord {
  return transitionLostReport(context, input, "ARCHIVED");
}
