import "server-only";

import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";
import { DomainError } from "@/shared/domain-error";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const standardLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "length",
)?.get;

function inspectAndClone(value: unknown, expectedBytes: number): Buffer {
  if (
    !Number.isInteger(expectedBytes)
    || expectedBytes < 0
    || expectedBytes > 64
    || typeof standardLengthGetter !== "function"
    || isProxy(value)
    || Object.getPrototypeOf(value) !== Buffer.prototype
    || !Buffer.isBuffer(value)
    || Object.getOwnPropertyDescriptor(value, "length") !== undefined
  ) throw new Error("invalid pickup buffer boundary");

  const expectedKeys = Array.from({ length: expectedBytes }, (_, index) => String(index));
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) throw new Error("invalid pickup buffer boundary");

  const bytes = expectedKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.writable !== true
      || descriptor.enumerable !== true
      || descriptor.configurable !== true
      || !Number.isInteger(descriptor.value)
      || descriptor.value < 0
      || descriptor.value > 255
    ) throw new Error("invalid pickup buffer boundary");
    return descriptor.value as number;
  });
  if (Reflect.apply(standardLengthGetter, value, []) !== expectedBytes) {
    throw new Error("invalid pickup buffer boundary");
  }
  return Buffer.from(bytes);
}

export function cloneStandardPickupBuffer(value: unknown, expectedBytes: number): Buffer {
  try {
    return inspectAndClone(value, expectedBytes);
  } catch {
    throw new DomainError("CONFIGURATION_ERROR");
  }
}
