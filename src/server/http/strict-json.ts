import { DomainError } from "@/shared/domain-error";

const MAX_JSON_BYTES = 4_096;

function requireJson(headers: Headers): void {
  const value = headers.get("content-type");
  if (!value || !/^application\/json(?:;\s*charset=UTF-8)?$/i.test(value)) {
    throw new DomainError("VALIDATION_FAILED");
  }
  const length = headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]{0,4})$/.test(length) || Number(length) > MAX_JSON_BYTES)) {
    throw new DomainError("VALIDATION_FAILED");
  }
}

export async function readStrictJson(request: Request): Promise<unknown> {
  requireJson(request.headers);
  if (!request.body) throw new DomainError("VALIDATION_FAILED");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new DomainError("VALIDATION_FAILED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new DomainError("VALIDATION_FAILED");
  }
}
