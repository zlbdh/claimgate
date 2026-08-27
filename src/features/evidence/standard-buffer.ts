import "server-only";

import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";
import { DomainError } from "@/shared/domain-error";

const MAX_EVIDENCE_BUFFER_BYTES = 1_024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const standardLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "length",
)?.get;

function invalid(): never {
  throw new Error("invalid evidence buffer boundary");
}

function inspectAndClone(value: unknown, expectedBytes: number): Buffer {
  if (
    typeof expectedBytes !== "number"
    || !Number.isInteger(expectedBytes)
    || expectedBytes < 0
    || expectedBytes > MAX_EVIDENCE_BUFFER_BYTES
    || typeof standardLengthGetter !== "function"
  ) invalid();

  // Buffer.isBuffer walks prototype chains, so reject direct/nested Proxies before calling it.
  if (isProxy(value) || Object.getPrototypeOf(value) !== Buffer.prototype) invalid();
  if (!Buffer.isBuffer(value)) invalid();
  if (Object.getOwnPropertyDescriptor(value, "length") !== undefined) invalid();

  const keys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length: expectedBytes }, (_, index) => String(index));
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) invalid();

  const bytes: number[] = [];
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.writable !== true
      || descriptor.enumerable !== true
      || descriptor.configurable !== true
      || typeof descriptor.value !== "number"
      || !Number.isInteger(descriptor.value)
      || descriptor.value < 0
      || descriptor.value > 255
    ) invalid();
    bytes.push(descriptor.value);
  }

  const standardLength = Reflect.apply(standardLengthGetter, value, []) as unknown;
  if (standardLength !== expectedBytes) invalid();
  return Buffer.from(bytes);
}

export function cloneStandardEvidenceBuffer(value: unknown, expectedBytes: number): Buffer {
  try {
    return inspectAndClone(value, expectedBytes);
  } catch {
    throw new DomainError("CONFIGURATION_ERROR");
  }
}
