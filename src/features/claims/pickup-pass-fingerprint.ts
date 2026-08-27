import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import type { Keyring } from "@/server/security/keyring";
import { parsePickupPassToken } from "./pickup-pass-crypto";
import type { PickupHandoffCommand, PickupIssuanceCommand } from "./pickup-pass-schema";

function lp(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function integer(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

export function pickupIssuanceFingerprint(
  action: "pickup_issue" | "pickup_reissue",
  claimId: string,
  input: PickupIssuanceCommand,
): string {
  const path = action === "pickup_issue"
    ? `/api/claims/${claimId}/pickup-pass/issue`
    : `/api/claims/${claimId}/pickup-pass/reissue`;
  return JSON.stringify({
    contract: `ClaimGate/${action}/v1`, method: "POST", path,
    claimId, expectedClaimVersion: input.expectedClaimVersion,
  });
}

export function handoffFingerprint(
  keyring: Keyring,
  claimId: string,
  input: PickupHandoffCommand,
): string {
  const tokenBytes = parsePickupPassToken(input.token);
  const fields = [
    Buffer.from("ClaimGate/handoff-fingerprint/v1"), Buffer.from("handoff"),
    Buffer.from(claimId), integer(input.expectedClaimVersion),
    integer(input.expectedItemVersion), integer(input.expectedReportVersion),
    integer(input.expectedGeneration), tokenBytes,
  ];
  return `cgh1.${createHmac("sha256", keyring.getKey("pickup-pass"))
    .update(Buffer.concat(fields.map(lp))).digest("base64url")}`;
}
