import {
  EVIDENCE_SLOTS,
  type EvidenceSlot,
} from "@/features/evidence/evidence-digester";
import type { ServerInternalEvidenceSlot } from "@/features/evidence/evidence-service";
import { cloneStandardEvidenceBuffer } from "@/features/evidence/standard-buffer";
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
    ) configurationError();
    const slot = row.slot as EvidenceSlot;
    bySlot.set(slot, Object.freeze({
      slot,
      salt: cloneStandardEvidenceBuffer(row.salt, 16),
      digest: cloneStandardEvidenceBuffer(row.digest, 32),
    }));
  }
  return EVIDENCE_SLOTS.map((slot) => bySlot.get(slot) ?? configurationError());
}
