import { createEvidenceDigester, type EvidenceDigestInput } from "@/features/evidence/evidence-digester";
import type { Keyring } from "@/server/security/keyring";

export function createPrivateEvidenceRecording(keyring: Keyring) {
  const calls: EvidenceDigestInput[] = [];
  const delegate = createEvidenceDigester(keyring.getKey("evidence"));
  return Object.freeze({
    calls,
    digester: Object.freeze({
      digest(input: EvidenceDigestInput) {
        calls.push({ ...input, salt: Buffer.from(input.salt) });
        return delegate.digest(input);
      },
    }),
    answersFor(itemId: string) {
      return Object.fromEntries(calls
        .filter((call) => call.itemId === itemId)
        .map((call) => [call.slot, call.value]));
    },
  });
}
