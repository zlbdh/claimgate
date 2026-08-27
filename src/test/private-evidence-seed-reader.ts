import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EVIDENCE_SLOTS = ["unique_mark", "contents_or_accessory", "identifier_suffix"] as const;
type EvidenceSlot = (typeof EVIDENCE_SLOTS)[number];

export function readPrivateEvidenceSeedForTest(seedIndex: number): Record<EvidenceSlot, string> {
  if (!Number.isSafeInteger(seedIndex) || seedIndex < 0 || seedIndex > 6) {
    throw new Error("invalid private evidence seed index");
  }
  const source = readFileSync(resolve("src/server/db/private-evidence-seed.ts"), "utf8");
  const block = new RegExp(`case ${seedIndex}: return \\{([\\s\\S]*?)\\n    \\};`).exec(source)?.[1];
  if (!block) throw new Error("private evidence seed block not found");
  const entries = EVIDENCE_SLOTS.map((slot) => {
    const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = new RegExp(`${escaped}: \\"([^\\"]+)\\"`).exec(block)?.[1];
    if (!value) throw new Error("private evidence seed slot not found");
    return [slot, value] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as Record<EvidenceSlot, string>;
}
