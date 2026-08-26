import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  ClaimRecord,
  CreateClaimInput,
  CreateLostReportInput,
  DemoInstance,
  IdempotencyRequest,
  LostReportRecord,
  PublicInventoryItem,
  RepositoryContext,
  RepositoryOptions,
  ServerInternalFoundItem,
  ServerInternalFoundItemMutationResult,
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
import { createLostReport as insertReport, getLostReport as readReport, listLostReports as readReports, updateLostReport as mutateReport } from "./report-repository";
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
  updateFoundItem(input: UpdateFoundItemInput): ServerInternalFoundItemMutationResult;
  createClaim(input: CreateClaimInput): ClaimRecord;
  updateClaim(input: UpdateClaimInput): ClaimRecord;
  listAuditEvents(demoInstanceId: string): AuditEvent[];
  runIdempotent<T>(request: IdempotencyRequest, mutation: () => T): T;
  withTransaction<T>(operation: (repository: ClaimGateRepository) => T): T;
};

export function createRepository(options: RepositoryOptions): ClaimGateRepository {
  const context: RepositoryContext = {
    database: options.database,
    now: options.now ?? Date.now,
    randomId: options.randomId ?? randomUUID,
  };
  const repository: ClaimGateRepository = {
    createDemoInstance: () => createInstance(context),
    getDemoInstance: (instanceId) => readInstance(context, instanceId),
    deleteExpiredDemoInstances: (atMs) => deleteExpired(context, atMs),
    listPublicInventory: (instanceId) => readPublicInventory(context, instanceId),
    listServerInternalFoundItems: (instanceId) => readInternalItems(context, instanceId),
    createLostReport: (input) => insertReport(context, input),
    getLostReport: (instanceId, reportId) => readReport(context, instanceId, reportId),
    listLostReports: (instanceId) => readReports(context, instanceId),
    updateLostReport: (input) => mutateReport(context, input),
    updateFoundItem: (input) => mutateItem(context, input),
    createClaim: (input) => insertClaim(context, input),
    updateClaim: (input) => mutateClaim(context, input),
    listAuditEvents: (instanceId) => {
      readInstance(context, instanceId);
      return readAuditEvents(context, instanceId);
    },
    runIdempotent: (request, mutation) => executeIdempotent(context, request, mutation),
    withTransaction: (operation) => {
      rejectAsyncCallback(operation);
      return options.database.transaction(() => {
        const result = operation(repository);
        rejectPromise(result);
        return result;
      }).immediate();
    },
  };
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
