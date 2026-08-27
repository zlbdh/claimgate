import { randomUUID } from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import type {
  AuditEvent,
  ApproveClaimInput,
  ClaimDecisionAck,
  ClaimEvent,
  ClaimRecord,
  CompletePickupHandoffInput,
  ConsumeActionNonceInput,
  CreateClaimInput,
  CreateLostReportInput,
  DemoInstance,
  EvidenceOutcomeInput,
  IdempotencyRequest,
  IdempotencyResult,
  HandoffAck,
  IssuePickupPassInput,
  PickupIssuanceIdempotencyRequest,
  PickupIssuanceMutation,
  PickupIssuanceResult,
  LostReportRecord,
  PublicInventoryItem,
  RepositoryContext,
  RepositoryOptions,
  ServerInternalFoundItem,
  ServerInternalFoundItemMutationResult,
  ServerInternalClaimEvidenceContext,
  ServerInternalPickupContext,
  StaffClaimDecisionInput,
  TransitionLostReportInput,
  UpdateClaimInput,
  UpdateFoundItemInput,
  UpdateLostReportInput,
} from "./repository-types";
import type { ServerInternalEvidenceSlot } from "@/features/evidence/evidence-service";
import { consumeActionNonce as consumeNonce } from "./action-nonce-repository";
import { listClaimEvents as readClaimEvents } from "./claim-event-repository";
import {
  getStaffClaimReview as readStaffClaimReview,
  listClaimTimeline as readClaimTimeline,
  listStaffReviewQueue as readStaffReviewQueue,
  type ClaimTimelineEntry,
  type StaffClaimReview,
  type StaffQueueEntry,
} from "./claim-read-repository";
import {
  approveClaim as approveClaimDecision,
  getServerInternalClaimEvidenceContext as readClaimEvidenceContext,
  recordEvidenceOutcome as applyEvidenceOutcome,
  rejectClaim as rejectClaimDecision,
  unlockClaim as unlockClaimDecision,
} from "./claim-decision-repository";
import { listAuditEvents as readAuditEvents } from "./audit-repository";
import {
  createDemoInstance as createInstance,
  deleteExpiredDemoInstances as deleteExpired,
  getDemoInstance as readInstance,
  listPublicInventory as readPublicInventory,
} from "./demo-repository";
import { createClaim as insertClaim, getClaim as readClaim, updateClaim as mutateClaim } from "./claim-repository";
import { listServerInternalFoundItems as readInternalItems, updateFoundItem as mutateItem } from "./inventory-repository";
import { runIdempotent as executeIdempotent } from "./idempotency-repository";
import { runPickupIssuanceIdempotent as executePickupIssuanceIdempotent } from "./pickup-issuance-idempotency";
import {
  archiveLostReport as archiveReport,
  createLostReport as insertReport,
  getLostReport as readReport,
  listLostReports as readReports,
  publishLostReport as publishReport,
  updateLostReport as mutateReport,
} from "./report-repository";
import { rejectAsyncCallback, rejectPromise } from "./repository-internal";
import { listServerInternalEvidenceSlots as readEvidenceSlots } from "./evidence-repository";
import {
  completePickupHandoff as completeHandoff,
  getServerInternalPickupContext as readPickupContext,
  issuePickupPass as issuePass,
} from "./pickup-pass-repository";

export type ClaimGateRepository = {
  createDemoInstance(): DemoInstance;
  getDemoInstance(demoInstanceId: string): DemoInstance;
  deleteExpiredDemoInstances(atMs: number): number;
  listPublicInventory(demoInstanceId: string): PublicInventoryItem[];
  listServerInternalFoundItems(demoInstanceId: string): ServerInternalFoundItem[];
  listServerInternalEvidenceSlots(
    demoInstanceId: string,
    itemId: string,
  ): ServerInternalEvidenceSlot[];
  createLostReport(input: CreateLostReportInput): LostReportRecord;
  getLostReport(demoInstanceId: string, reportId: string): LostReportRecord;
  listLostReports(demoInstanceId: string): LostReportRecord[];
  updateLostReport(input: UpdateLostReportInput): LostReportRecord;
  publishLostReport(input: TransitionLostReportInput): LostReportRecord;
  archiveLostReport(input: TransitionLostReportInput): LostReportRecord;
  updateFoundItem(input: UpdateFoundItemInput): ServerInternalFoundItemMutationResult;
  createClaim(input: CreateClaimInput): ClaimRecord;
  getClaim(demoInstanceId: string, claimId: string): ClaimRecord;
  updateClaim(input: UpdateClaimInput): ClaimRecord;
  getServerInternalClaimEvidenceContext(
    demoInstanceId: string,
    claimId: string,
  ): ServerInternalClaimEvidenceContext;
  recordEvidenceOutcome(input: EvidenceOutcomeInput): ClaimDecisionAck;
  approveClaim(input: ApproveClaimInput): ClaimDecisionAck;
  rejectClaim(input: StaffClaimDecisionInput): ClaimDecisionAck;
  unlockClaim(input: StaffClaimDecisionInput): ClaimDecisionAck;
  getServerInternalPickupContext(
    demoInstanceId: string,
    claimId: string,
  ): ServerInternalPickupContext;
  issuePickupPass(input: IssuePickupPassInput): import("./repository-types").PickupPassAck;
  completePickupHandoff(input: CompletePickupHandoffInput): HandoffAck;
  listClaimEvents(demoInstanceId: string, claimId: string, limit?: number): ClaimEvent[];
  listStaffReviewQueue(demoInstanceId: string, limit: number): StaffQueueEntry[];
  getStaffClaimReview(demoInstanceId: string, claimId: string): StaffClaimReview;
  listClaimTimeline(demoInstanceId: string, claimId: string, limit: number): ClaimTimelineEntry[];
  listAuditEvents(demoInstanceId: string): AuditEvent[];
  runIdempotent(request: IdempotencyRequest, mutation: () => IdempotencyResult): IdempotencyResult;
  runPickupIssuanceIdempotent(
    request: PickupIssuanceIdempotencyRequest,
    mutation: () => PickupIssuanceMutation,
  ): PickupIssuanceResult;
  consumeActionNonce(input: ConsumeActionNonceInput): void;
  withTransaction<T>(operation: (
    repository: ClaimGateRepository,
  ) => T extends PromiseLike<unknown> ? never : T): T;
};

export function createRepository(options: RepositoryOptions): ClaimGateRepository {
  if (
    !options
    || !options.evidenceDigester
    || typeof options.evidenceDigester.digest !== "function"
    || !Object.isFrozen(options.evidenceDigester)
    || typeof options.randomBytes !== "function"
  ) throw new DomainError("CONFIGURATION_ERROR");
  const context: RepositoryContext = {
    database: options.database,
    now: options.now ?? Date.now,
    randomId: options.randomId ?? randomUUID,
    evidenceDigester: options.evidenceDigester,
    randomBytes: options.randomBytes,
  };
  const buildRepository = (assertActive: () => void): ClaimGateRepository => ({
    createDemoInstance: () => { assertActive(); return createInstance(context); },
    getDemoInstance: (instanceId) => { assertActive(); return readInstance(context, instanceId); },
    deleteExpiredDemoInstances: (atMs) => { assertActive(); return deleteExpired(context, atMs); },
    listPublicInventory: (instanceId) => { assertActive(); return readPublicInventory(context, instanceId); },
    listServerInternalFoundItems: (instanceId) => { assertActive(); return readInternalItems(context, instanceId); },
    listServerInternalEvidenceSlots: (instanceId, itemId) => {
      assertActive();
      return readEvidenceSlots(context, instanceId, itemId);
    },
    createLostReport: (input) => { assertActive(); return insertReport(context, input); },
    getLostReport: (instanceId, reportId) => { assertActive(); return readReport(context, instanceId, reportId); },
    listLostReports: (instanceId) => { assertActive(); return readReports(context, instanceId); },
    updateLostReport: (input) => { assertActive(); return mutateReport(context, input); },
    publishLostReport: (input) => { assertActive(); return publishReport(context, input); },
    archiveLostReport: (input) => { assertActive(); return archiveReport(context, input); },
    updateFoundItem: (input) => { assertActive(); return mutateItem(context, input); },
    createClaim: (input) => { assertActive(); return insertClaim(context, input); },
    getClaim: (instanceId, claimId) => { assertActive(); return readClaim(context, instanceId, claimId); },
    updateClaim: (input) => { assertActive(); return mutateClaim(context, input); },
    getServerInternalClaimEvidenceContext: (instanceId, claimId) => {
      assertActive();
      return readClaimEvidenceContext(context, instanceId, claimId);
    },
    recordEvidenceOutcome: (input) => { assertActive(); return applyEvidenceOutcome(context, input); },
    approveClaim: (input) => { assertActive(); return approveClaimDecision(context, input); },
    rejectClaim: (input) => { assertActive(); return rejectClaimDecision(context, input); },
    unlockClaim: (input) => { assertActive(); return unlockClaimDecision(context, input); },
    getServerInternalPickupContext: (instanceId, claimId) => {
      assertActive(); return readPickupContext(context, instanceId, claimId);
    },
    issuePickupPass: (input) => { assertActive(); return issuePass(context, input); },
    completePickupHandoff: (input) => { assertActive(); return completeHandoff(context, input); },
    listClaimEvents: (instanceId, claimId, limit) => {
      assertActive();
      readClaim(context, instanceId, claimId);
      return readClaimEvents(context, instanceId, claimId, limit);
    },
    listStaffReviewQueue: (instanceId, limit) => {
      assertActive(); return readStaffReviewQueue(context, instanceId, limit);
    },
    getStaffClaimReview: (instanceId, claimId) => {
      assertActive(); return readStaffClaimReview(context, instanceId, claimId);
    },
    listClaimTimeline: (instanceId, claimId, limit) => {
      assertActive(); return readClaimTimeline(context, instanceId, claimId, limit);
    },
    listAuditEvents: (instanceId) => {
      assertActive();
      readInstance(context, instanceId);
      return readAuditEvents(context, instanceId);
    },
    runIdempotent: (request, mutation) => {
      assertActive();
      return executeIdempotent(context, request, mutation);
    },
    runPickupIssuanceIdempotent: (request, mutation) => {
      assertActive();
      return executePickupIssuanceIdempotent(context, request, mutation);
    },
    consumeActionNonce: (input) => { assertActive(); consumeNonce(context, input); },
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
  ClaimDecisionAck,
  ClaimEvent,
  DemoInstance,
  LostReportRecord,
  PublicInventoryItem,
  ServerInternalFoundItem,
  ServerInternalFoundItemMutationResult,
} from "./repository-types";
