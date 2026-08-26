import { DEMO_IDENTITIES, type DemoUserId } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import type { Keyring } from "@/server/security/keyring";
import type {
  ClaimGateRepository,
  LostReportRecord,
  ServerInternalFoundItem,
} from "@/server/db/repository";
import { findMatches } from "@/features/matching/match-service";
import {
  mintCandidateHandles,
  resolveCandidateHandle,
} from "@/features/matching/candidate-handle";
import type { FoundItem } from "@/features/inventory/found-item";
import {
  validateCreateReportCommand,
  validateUpdateReportCommand,
  type CreateReportCommand,
  type UpdateReportCommand,
} from "./report-schema";
import { createReportFingerprint, updateReportFingerprint } from "./report-fingerprint";
import type {
  BrowserCandidateDto,
  CandidateListDto,
  PublicReportDto,
  ReportAckDto,
} from "./report-types";

type ReportActorContext = Readonly<{
  demoInstanceId: string;
  actorId: DemoUserId;
  sessionExpiresAt: number;
}>;

type MatchSnapshot = Readonly<{
  report: LostReportRecord;
  catalogVersion: number;
  instanceExpiresAt: number;
  matches: ReturnType<typeof findMatches>;
}>;

function requireClaimant(context: ReportActorContext): void {
  if (context.actorId !== DEMO_IDENTITIES.CLAIMANT.userId) throw new DomainError("FORBIDDEN");
}

function requireOwned(
  repository: ClaimGateRepository,
  context: ReportActorContext,
  reportId: string,
): LostReportRecord {
  const report = repository.getLostReport(context.demoInstanceId, reportId);
  if (report.ownerActorId !== context.actorId) throw new DomainError("NOT_FOUND");
  return report;
}

function toPublicReport(report: LostReportRecord): PublicReportDto {
  return Object.freeze({
    reportId: report.reportId,
    category: report.category,
    timeWindow: Object.freeze({ ...report.timeWindow }),
    area: report.area,
    color: report.color,
    publicTags: Object.freeze([...report.publicTags]),
    publicDescription: report.publicDescription,
    status: report.status,
    version: report.version,
  });
}

function toAck(result: { reportId: string; status: "DRAFT"; version: number }): ReportAckDto {
  return Object.freeze({
    reportId: result.reportId,
    status: result.status,
    version: result.version,
    nextPath: `/claimant/reports/${result.reportId}`,
  });
}

function toMatchItem(item: ServerInternalFoundItem): FoundItem {
  return {
    inventoryItemId: item.inventoryItemId,
    category: item.category,
    foundAt: item.foundAt,
    area: item.area,
    color: item.color,
    publicTags: [...item.publicTags],
    publicDescription: item.publicDescription,
  };
}

export function createReportService(dependencies: {
  repository: ClaimGateRepository;
  keyring: Keyring;
  now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;

  function snapshot(context: ReportActorContext, reportId: string, staleState = false): MatchSnapshot {
    requireClaimant(context);
    return dependencies.repository.withTransaction((repository) => {
      const instance = repository.getDemoInstance(context.demoInstanceId);
      const report = requireOwned(repository, context, reportId);
      if (report.status !== "PUBLISHED") {
        throw new DomainError(staleState ? "STATE_CHANGED" : "INVALID_STATE_TRANSITION");
      }
      const available = repository.listServerInternalFoundItems(context.demoInstanceId)
        .filter((item) => item.status === "AVAILABLE")
        .map(toMatchItem);
      return Object.freeze({
        report,
        catalogVersion: instance.catalogVersion,
        instanceExpiresAt: instance.expiresAtMs,
        matches: findMatches(report, available, 3),
      });
    });
  }

  return Object.freeze({
    createDraft(context: ReportActorContext, untrusted: CreateReportCommand): ReportAckDto {
      requireClaimant(context);
      const input = validateCreateReportCommand(untrusted);
      const result = dependencies.repository.withTransaction((repository) => repository.runIdempotent({
        demoInstanceId: context.demoInstanceId,
        actorId: context.actorId,
        action: "draft_create",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: createReportFingerprint(input),
      }, () => {
        const report = repository.createLostReport({
          demoInstanceId: context.demoInstanceId,
          ownerActorId: context.actorId,
          category: input.category,
          timeWindow: input.timeWindow,
          area: input.area,
          color: input.color,
          publicTags: input.publicTags,
          publicDescription: input.publicDescription,
        });
        return { kind: "report_ack", reportId: report.reportId, status: "DRAFT", version: report.version };
      }));
      if (result.kind !== "report_ack") throw new DomainError("CONFIGURATION_ERROR");
      return toAck(result);
    },

    updateDraft(
      context: ReportActorContext,
      reportId: string,
      untrusted: UpdateReportCommand,
    ): ReportAckDto {
      requireClaimant(context);
      const input = validateUpdateReportCommand(untrusted);
      const result = dependencies.repository.withTransaction((repository) => repository.runIdempotent({
        demoInstanceId: context.demoInstanceId,
        actorId: context.actorId,
        action: "draft_update",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: updateReportFingerprint(reportId, input),
      }, () => {
        const existing = requireOwned(repository, context, reportId);
        if (existing.version !== input.expectedVersion) throw new DomainError("STATE_CHANGED");
        if (existing.status !== "DRAFT") throw new DomainError("INVALID_STATE_TRANSITION");
        const report = repository.updateLostReport({
          demoInstanceId: context.demoInstanceId,
          reportId,
          expectedVersion: input.expectedVersion,
          actorId: context.actorId,
          patch: input.patch,
        });
        return { kind: "report_ack", reportId: report.reportId, status: "DRAFT", version: report.version };
      }));
      if (result.kind !== "report_ack") throw new DomainError("CONFIGURATION_ERROR");
      return toAck(result);
    },

    publish(context: ReportActorContext, reportId: string, expectedVersion: number): PublicReportDto {
      requireClaimant(context);
      return dependencies.repository.withTransaction((repository) => {
        requireOwned(repository, context, reportId);
        return toPublicReport(repository.publishLostReport({
          demoInstanceId: context.demoInstanceId, reportId, expectedVersion, actorId: context.actorId,
        }));
      });
    },

    archive(context: ReportActorContext, reportId: string, expectedVersion: number): PublicReportDto {
      requireClaimant(context);
      return dependencies.repository.withTransaction((repository) => {
        requireOwned(repository, context, reportId);
        return toPublicReport(repository.archiveLostReport({
          demoInstanceId: context.demoInstanceId, reportId, expectedVersion, actorId: context.actorId,
        }));
      });
    },

    listOwned(context: ReportActorContext): PublicReportDto[] {
      requireClaimant(context);
      return dependencies.repository.listLostReports(context.demoInstanceId)
        .filter((report) => report.ownerActorId === context.actorId)
        .slice(0, 50)
        .map(toPublicReport);
    },

    getOwned(context: ReportActorContext, reportId: string): PublicReportDto {
      requireClaimant(context);
      return toPublicReport(requireOwned(dependencies.repository, context, reportId));
    },

    findCandidates(context: ReportActorContext, reportId: string, limit = 3): CandidateListDto {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw new DomainError("VALIDATION_FAILED");
      const current = snapshot(context, reportId);
      const nowMs = now();
      const ceilingMs = Math.min(context.sessionExpiresAt, current.instanceExpiresAt);
      const handles = mintCandidateHandles({
        key: dependencies.keyring.getKey("candidate-handle"),
        nowMs,
        ceilingMs,
        demoInstanceId: context.demoInstanceId,
        reportId,
        reportVersion: current.report.version,
        catalogVersion: current.catalogVersion,
        inventoryItemIds: current.matches.map((match) => match.inventoryItemId),
      });
      const candidates = current.matches.slice(0, limit).map((match, index): BrowserCandidateDto => Object.freeze({
        candidateHandle: handles[index]!,
        category: match.item.category,
        timeBand: match.timeBand,
        area: match.item.area,
        color: match.item.color,
        confidence: match.confidence,
        reasons: Object.freeze([...match.reasons]),
        expiresAt: Number(handles[index]!.split(".")[2]),
      }));
      return Object.freeze({
        candidates: Object.freeze(candidates),
        message: candidates.length === 0
          ? "No close candidates yet. Refine the public time window, area, color, or descriptors."
          : `${candidates.length} privacy-safe candidate${candidates.length === 1 ? "" : "s"} found.`,
      });
    },

    resolveCandidate(context: ReportActorContext, reportId: string, handle: string): string {
      const current = snapshot(context, reportId, true);
      return resolveCandidateHandle({
        key: dependencies.keyring.getKey("candidate-handle"),
        nowMs: now(),
        ceilingMs: Math.min(context.sessionExpiresAt, current.instanceExpiresAt),
        demoInstanceId: context.demoInstanceId,
        reportId,
        reportVersion: current.report.version,
        catalogVersion: current.catalogVersion,
        inventoryItemIds: current.matches.map((match) => match.inventoryItemId),
        handle,
      });
    },
  });
}

export type ReportService = ReturnType<typeof createReportService>;
