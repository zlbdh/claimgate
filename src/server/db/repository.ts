import { randomUUID } from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import type {
  AuditEvent,
  ClaimRecord,
  CreateClaimInput,
  CreateLostReportInput,
  DemoInstance,
  IdempotencyRequest,
  IdempotencyResult,
  LostReportRecord,
  PublicInventoryItem,
  RepositoryContext,
  RepositoryOptions,
  ServerInternalFoundItem,
  ServerInternalFoundItemMutationResult,
  TransitionLostReportInput,
  UpdateClaimInput,
  UpdateFoundItemInput,
  UpdateLostReportInput,
} from "./repository-types";
import { listAuditEvents as readAuditEvents } from "./audit-repository";
import {
  createDemoInstance as createInstance,
  deleteExpiredDemoInstances as deleteExpired,
  getDemoInstance as readInstance,
  listPublicInventory as readPublicInventory,
} from "./demo-repository";
import { createClaim as insertClaim, updateClaim as mutateClaim } from "./claim-repository";
import { listServerInternalFoundItems as readInternalItems, updateFoundItem as mutateItem } from "./inventory-repository";
import { runIdempotent as executeIdempotent } from "./idempotency-repository";
import {
  archiveLostReport as archiveReport,
  createLostReport as insertReport,
  getLostReport as readReport,
  listLostReports as readReports,
  publishLostReport as publishReport,
  updateLostReport as mutateReport,
} from "./report-repository";
import { rejectAsyncCallback, rejectPromise } from "./repository-internal";

export type ClaimGateRepository = {
  createDemoInstance(): DemoInstance;
  getDemoInstance(demoInstanceId: string): DemoInstance;
  deleteExpiredDemoInstances(atMs: number): number;
  listPublicInventory(demoInstanceId: string): PublicInventoryItem[];
  listServerInternalFoundItems(demoInstanceId: string): ServerInternalFoundItem[];
  createLostReport(input: CreateLostReportInput): LostReportRecord;
  getLostReport(demoInstanceId: string, reportId: string): LostReportRecord;
  listLostReports(demoInstanceId: string): LostReportRecord[];
  updateLostReport(input: UpdateLostReportInput): LostReportRecord;
  publishLostReport(input: TransitionLostReportInput): LostReportRecord;
  archiveLostReport(input: TransitionLostReportInput): LostReportRecord;
  updateFoundItem(input: UpdateFoundItemInput): ServerInternalFoundItemMutationResult;
  createClaim(input: CreateClaimInput): ClaimRecord;
  updateClaim(input: UpdateClaimInput): ClaimRecord;
  listAuditEvents(demoInstanceId: string): AuditEvent[];
  runIdempotent(request: IdempotencyRequest, mutation: () => IdempotencyResult): IdempotencyResult;
  withTransaction<T>(operation: (
    repository: ClaimGateRepository,
  ) => T extends PromiseLike<unknown> ? never : T): T;
};

export function createRepository(options: RepositoryOptions): ClaimGateRepository {
  const context: RepositoryContext = {
    database: options.database,
    now: options.now ?? Date.now,
    randomId: options.randomId ?? randomUUID,
  };
  const buildRepository = (assertActive: () => void): ClaimGateRepository => ({
    createDemoInstance: () => { assertActive(); return createInstance(context); },
    getDemoInstance: (instanceId) => { assertActive(); return readInstance(context, instanceId); },
    deleteExpiredDemoInstances: (atMs) => { assertActive(); return deleteExpired(context, atMs); },
    listPublicInventory: (instanceId) => { assertActive(); return readPublicInventory(context, instanceId); },
    listServerInternalFoundItems: (instanceId) => { assertActive(); return readInternalItems(context, instanceId); },
    createLostReport: (input) => { assertActive(); return insertReport(context, input); },
    getLostReport: (instanceId, reportId) => { assertActive(); return readReport(context, instanceId, reportId); },
    listLostReports: (instanceId) => { assertActive(); return readReports(context, instanceId); },
    updateLostReport: (input) => { assertActive(); return mutateReport(context, input); },
    publishLostReport: (input) => { assertActive(); return publishReport(context, input); },
    archiveLostReport: (input) => { assertActive(); return archiveReport(context, input); },
    updateFoundItem: (input) => { assertActive(); return mutateItem(context, input); },
    createClaim: (input) => { assertActive(); return insertClaim(context, input); },
    updateClaim: (input) => { assertActive(); return mutateClaim(context, input); },
    listAuditEvents: (instanceId) => {
      assertActive();
      readInstance(context, instanceId);
      return readAuditEvents(context, instanceId);
    },
    runIdempotent: (request, mutation) => {
      assertActive();
      return executeIdempotent(context, request, mutation);
    },
    withTransaction: (operation) => {
      assertActive();
      rejectAsyncCallback(operation);
      return options.database.transaction(() => {
        let active = true;
        const scopedRepository = buildRepository(() => {
          if (!active) throw new DomainError("CONFIGURATION_ERROR");
        });
        try {
          const result = operation(scopedRepository);
          rejectPromise(result);
          return result;
        } finally {
          active = false;
        }
      }).immediate();
    },
  });
  const repository = buildRepository(() => undefined);
  return repository;
}

export type {
  AuditEvent,
  ClaimRecord,
  DemoInstance,
  LostReportRecord,
  PublicInventoryItem,
  ServerInternalFoundItem,
  ServerInternalFoundItemMutationResult,
} from "./repository-types";
