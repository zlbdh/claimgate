import { DomainError } from "@/shared/domain-error";

export const MAX_FORM_BODY_BYTES = 4_096;

function requireUrlEncodedContentType(headers: Headers): void {
  const value = headers.get("content-type");
  if (
    !value
    || !/^application\/x-www-form-urlencoded(?:;\s*charset=UTF-8)?$/i.test(value)
  ) throw new DomainError("VALIDATION_FAILED");
}

function requireDeclaredLength(headers: Headers): void {
  const value = headers.get("content-length");
  if (value === null) return;
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > MAX_FORM_BODY_BYTES) {
    throw new DomainError("VALIDATION_FAILED");
  }
}

async function readBoundedBytes(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FORM_BODY_BYTES) {
        await reader.cancel();
        throw new DomainError("VALIDATION_FAILED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeComponent(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (value[index] === "%") {
      const pair = value.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(pair)) throw new DomainError("VALIDATION_FAILED");
      bytes.push(Number.parseInt(pair, 16));
      index += 2;
    } else if (value[index] === "+") {
      bytes.push(0x20);
    } else {
      if (code > 0x7f) throw new DomainError("VALIDATION_FAILED");
      bytes.push(code);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new DomainError("VALIDATION_FAILED");
  }
}

function parseStrictUrlEncoded(value: string): ReadonlyArray<readonly [string, string]> {
  if (value === "") return Object.freeze([]);
  const entries = value.split("&").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) throw new DomainError("VALIDATION_FAILED");
    return Object.freeze([
      decodeComponent(part.slice(0, separator)),
      decodeComponent(part.slice(separator + 1)),
    ] as const);
  });
  return Object.freeze(entries);
}

export async function readStrictUrlEncodedForm(
  request: Request,
): Promise<ReadonlyArray<readonly [string, string]>> {
  requireUrlEncodedContentType(request.headers);
  requireDeclaredLength(request.headers);
  const bytes = await readBoundedBytes(request);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError("VALIDATION_FAILED");
  }
  return parseStrictUrlEncoded(text);
}
