import { Buffer } from "node:buffer";
import type {
  EvidenceDigester,
  EvidenceSlot,
} from "@/features/evidence/evidence-digester";
import { EVIDENCE_SLOTS } from "@/features/evidence/evidence-digester";
import {
  verifyEvidence,
  type ServerInternalEvidenceSlot,
} from "@/features/evidence/evidence-service";
import { normalizeEvidence } from "@/features/evidence/normalize-evidence";
import { DomainError } from "@/shared/domain-error";
import type { RepositoryContext } from "./repository-types";

type FictionalAnswers = Record<EvidenceSlot, string>;

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
): void {
  const answers = materializeFictionalAnswers(seedIndex);
  const insert = context.database.prepare(`
    INSERT INTO item_evidence_slots (
      demo_instance_id, found_item_id, slot, salt, digest
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const slot of EVIDENCE_SLOTS) {
    const generated = context.randomBytes(16);
    if (!Buffer.isBuffer(generated) || generated.length !== 16) configurationError();
    const salt = Buffer.from(generated);
    const digest = context.evidenceDigester.digest({
      demoInstanceId,
      itemId,
      slot,
      salt,
      value: answers[slot],
    });
    if (!Buffer.isBuffer(digest) || digest.length !== 32) configurationError();
    insert.run(demoInstanceId, itemId, slot, salt, Buffer.from(digest));
  }
}

export function verifyFictionalSeedForTest(input: {
  seedIndex: number;
  digester: EvidenceDigester;
  demoInstanceId: string;
  itemId: string;
  storedSlots: readonly ServerInternalEvidenceSlot[];
}) {
  const answers = materializeFictionalAnswers(input.seedIndex);
  return verifyEvidence({
    ...input,
    answers,
    priorFailedAttempts: 0,
  });
}

export function privateEvidenceSeedsAreDistinctForTest(): boolean {
  const values = Array.from({ length: 7 }, (_, index) => materializeFictionalAnswers(index))
    .flatMap((answers) => EVIDENCE_SLOTS.map((slot) => normalizeEvidence(answers[slot])));
  return new Set(values).size === 21;
}

export function privateEvidenceAppearsInForTest(value: unknown): boolean {
  const privateValues = Array.from({ length: 7 }, (_, index) => materializeFictionalAnswers(index))
    .flatMap((answers) => EVIDENCE_SLOTS.flatMap((slot) => [
      answers[slot],
      normalizeEvidence(answers[slot]),
    ]));
  const seen = new Set<object>();
  const inspect = (entry: unknown): boolean => {
    if (typeof entry === "string") return privateValues.some((secret) => entry.includes(secret));
    if (Buffer.isBuffer(entry)) return inspect(entry.toString("utf8"));
    if (!entry || typeof entry !== "object" || seen.has(entry)) return false;
    seen.add(entry);
    return Reflect.ownKeys(entry).some((key) => inspect(key) || inspect(Reflect.get(entry, key)));
  };
  return inspect(value);
}
