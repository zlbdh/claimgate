import { Buffer } from "node:buffer";
import {
  EVIDENCE_SLOTS,
  type EvidenceSlot,
} from "@/features/evidence/evidence-digester";
import type { ServerInternalEvidenceSlot } from "@/features/evidence/evidence-service";
import { DomainError } from "@/shared/domain-error";
import { activeInstance, requireText } from "./repository-internal";
import type { RepositoryContext } from "./repository-types";

type EvidenceRow = {
  slot: unknown;
  salt: unknown;
  digest: unknown;
};

function configurationError(): never {
  throw new DomainError("CONFIGURATION_ERROR");
}

export function listServerInternalEvidenceSlots(
  context: RepositoryContext,
  demoInstanceId: string,
  itemId: string,
): ServerInternalEvidenceSlot[] {
  activeInstance(context, demoInstanceId);
  requireText(itemId);
  const item = context.database.prepare(`
    SELECT 1 FROM found_items WHERE demo_instance_id = ? AND id = ?
  `).get(demoInstanceId, itemId);
  if (!item) throw new DomainError("NOT_FOUND");
  const rows = context.database.prepare(`
    SELECT slot, salt, digest FROM item_evidence_slots
    WHERE demo_instance_id = ? AND found_item_id = ?
  `).all(demoInstanceId, itemId) as EvidenceRow[];
  if (rows.length !== EVIDENCE_SLOTS.length) configurationError();
  const bySlot = new Map<EvidenceSlot, ServerInternalEvidenceSlot>();
  for (const row of rows) {
    if (
      typeof row.slot !== "string"
      || !EVIDENCE_SLOTS.includes(row.slot as EvidenceSlot)
      || bySlot.has(row.slot as EvidenceSlot)
      || !Buffer.isBuffer(row.salt)
      || row.salt.length !== 16
      || !Buffer.isBuffer(row.digest)
      || row.digest.length !== 32
    ) configurationError();
    const slot = row.slot as EvidenceSlot;
    bySlot.set(slot, Object.freeze({
      slot,
      salt: Buffer.from(row.salt),
      digest: Buffer.from(row.digest),
    }));
  }
  return EVIDENCE_SLOTS.map((slot) => bySlot.get(slot) ?? configurationError());
}
