import "server-only";

import { Buffer } from "node:buffer";
import type { EvidenceSlot } from "@/features/evidence/evidence-digester";
import { EVIDENCE_SLOTS } from "@/features/evidence/evidence-digester";
import { DomainError } from "@/shared/domain-error";
import type { RepositoryContext } from "./repository-types";

type FictionalAnswers = Record<EvidenceSlot, string>;
type EvidenceSaltState = {
  sources: Set<Buffer>;
  values: Set<string>;
};

function configurationError(): never {
  throw new DomainError("CONFIGURATION_ERROR");
}

function materializeFictionalAnswers(seedIndex: number): FictionalAnswers {
  switch (seedIndex) {
    case 0: return {
      unique_mark: "tiny blue star engraving",
      contents_or_accessory: "short braided charging cable",
      identifier_suffix: "nbx-4821",
    };
    case 1: return {
      unique_mark: "small copper crescent sticker",
      contents_or_accessory: "single silicone ear tip",
      identifier_suffix: "kqv-7350",
    };
    case 2: return {
      unique_mark: "two pale diagonal scratches",
      contents_or_accessory: "navy fabric wrist loop",
      identifier_suffix: "mzt-1604",
    };
    case 3: return {
      unique_mark: "green triangle ink mark",
      contents_or_accessory: "coiled black audio adapter",
      identifier_suffix: "rpd-9286",
    };
    case 4: return {
      unique_mark: "faint silver cloud decal",
      contents_or_accessory: "white replacement ear tip pair",
      identifier_suffix: "wlc-3147",
    };
    case 5: return {
      unique_mark: "orange square paint fleck",
      contents_or_accessory: "gray woven carry strap",
      identifier_suffix: "hfj-6073",
    };
    case 6: return {
      unique_mark: "three narrow violet dots",
      contents_or_accessory: "clear protective shell",
      identifier_suffix: "svg-8529",
    };
    default: configurationError();
  }
}

export function seedPrivateEvidenceForItem(
  context: RepositoryContext,
  demoInstanceId: string,
  itemId: string,
  seedIndex: number,
  saltState: EvidenceSaltState,
): void {
  const answers = materializeFictionalAnswers(seedIndex);
  const insert = context.database.prepare(`
    INSERT INTO item_evidence_slots (
      demo_instance_id, found_item_id, slot, salt, digest
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const slot of EVIDENCE_SLOTS) {
    let generated: Buffer;
    try {
      generated = context.randomBytes(16);
    } catch {
      configurationError();
    }
    if (!Buffer.isBuffer(generated) || generated.length !== 16) configurationError();
    if (saltState.sources.has(generated)) configurationError();
    saltState.sources.add(generated);
    const salt = Buffer.from(generated);
    const saltKey = salt.toString("hex");
    if (saltState.values.has(saltKey)) configurationError();
    const existing = context.database.prepare(`
      SELECT 1 FROM item_evidence_slots WHERE salt = ? LIMIT 1
    `).get(salt);
    if (existing) configurationError();
    saltState.values.add(saltKey);
    let digest: Buffer;
    try {
      digest = context.evidenceDigester.digest({
        demoInstanceId,
        itemId,
        slot,
        salt: Buffer.from(salt),
        value: answers[slot],
      });
    } catch {
      configurationError();
    }
    if (!Buffer.isBuffer(digest) || digest.length !== 32) configurationError();
    try {
      insert.run(demoInstanceId, itemId, slot, salt, Buffer.from(digest));
    } catch {
      configurationError();
    }
  }
}
