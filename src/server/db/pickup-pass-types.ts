import type { ClaimStatus, ItemStatus, ReportStatus } from "@/features/claims/claim-state";

export type PickupIssuanceAction = "pickup_issue" | "pickup_reissue";

export type PickupIssuanceIdempotencyRequest = Readonly<{
  demoInstanceId: string;
  actorId: string;
  action: PickupIssuanceAction;
  idempotencyKey: string;
  requestFingerprint: string;
  expectedClaimId: string;
}>;

export type PickupPassAck = Readonly<{
  kind: "pickup_pass_ack";
  claimId: string;
  status: "PICKUP_READY";
  claimVersion: number;
  generation: number;
  expiresAtMs: number;
}>;

export type PickupIssuanceMutation = Readonly<{
  safeAck: PickupPassAck;
  transientToken: string;
}>;

export type PickupIssuanceResult = Readonly<{
  issuance: "ISSUED";
  ack: PickupPassAck;
  transientToken: string;
}> | Readonly<{
  issuance: "ALREADY_ISSUED";
  ack: PickupPassAck;
}>;

export type ServerInternalPickupContext = Readonly<{
  claimantActorId: string;
  claimStatus: ClaimStatus;
  claimVersion: number;
  salt: Buffer | null;
  digest: Buffer | null;
  expiresAtMs: number | null;
  consumedAtMs: number | null;
  generation: number;
  itemStatus: ItemStatus;
  itemVersion: number;
  reportStatus: ReportStatus;
  reportVersion: number;
  instanceExpiresAtMs: number;
}>;

export type IssuePickupPassInput = Readonly<{
  demoInstanceId: string;
  claimId: string;
  claimantActorId: string;
  action: PickupIssuanceAction;
  expectedClaimVersion: number;
  generation: number;
  expiresAtMs: number;
  salt: Buffer;
  digest: Buffer;
}>;

export type CompletePickupHandoffInput = Readonly<{
  demoInstanceId: string;
  claimId: string;
  staffActorId: string;
  expectedClaimVersion: number;
  expectedItemVersion: number;
  expectedReportVersion: number;
  expectedGeneration: number;
}>;

export type HandoffAck = Readonly<{
  kind: "handoff_ack";
  claimId: string;
  completion: "COLLECTED" | "ALREADY_COLLECTED";
  claimStatus: "COLLECTED";
  claimVersion: number;
  itemStatus: "RETURNED";
  itemVersion: number;
  reportStatus: "RESOLVED";
  reportVersion: number;
  generation: number;
}>;
