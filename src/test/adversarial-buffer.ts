import { Buffer } from "node:buffer";

export type TrapCounter = { count: number };

export type AdversarialBufferKind =
  | "subclass"
  | "custom-prototype"
  | "own-length"
  | "own-length-data"
  | "extra-index"
  | "extra-string"
  | "value-of"
  | "extra-symbol"
  | "iterator"
  | "proxy-prototype"
  | "proxy";

export const ADVERSARIAL_BUFFER_KINDS = Object.freeze([
  "subclass",
  "custom-prototype",
  "own-length",
  "own-length-data",
  "extra-index",
  "extra-string",
  "value-of",
  "extra-symbol",
  "iterator",
  "proxy-prototype",
  "proxy",
] as const);

export function adversarialBuffer(
  kind: AdversarialBufferKind,
  size: number,
  counter: TrapCounter,
): Buffer {
  const value = Buffer.alloc(size, 29);
  switch (kind) {
    case "subclass": {
      class BufferSubclass extends Buffer {}
      Object.setPrototypeOf(value, BufferSubclass.prototype);
      return value;
    }
    case "custom-prototype": {
      const prototype = Object.create(Buffer.prototype);
      Object.defineProperties(prototype, {
        length: {
          get() { counter.count += 1; return size; },
        },
        0: {
          get() { counter.count += 1; return 29; },
        },
      });
      Object.setPrototypeOf(value, prototype);
      return value;
    }
    case "own-length":
      Object.defineProperty(value, "length", {
        configurable: true,
        get() { counter.count += 1; return size; },
      });
      return value;
    case "own-length-data":
      Object.defineProperty(value, "length", {
        configurable: true,
        value: size,
      });
      return value;
    case "extra-index":
      Object.defineProperty(value, "01", {
        configurable: true,
        get() { counter.count += 1; return 29; },
      });
      return value;
    case "extra-string":
      Object.defineProperty(value, "toJSON", {
        configurable: true,
        get() { counter.count += 1; return () => "must not run"; },
      });
      return value;
    case "value-of":
      Object.defineProperty(value, "valueOf", {
        configurable: true,
        get() { counter.count += 1; return () => 29; },
      });
      return value;
    case "extra-symbol":
      Object.defineProperty(value, Symbol("hidden"), {
        configurable: true,
        get() { counter.count += 1; return "must not run"; },
      });
      return value;
    case "iterator":
      Object.defineProperty(value, Symbol.iterator, {
        configurable: true,
        get() { counter.count += 1; return () => [29][Symbol.iterator](); },
      });
      return value;
    case "proxy-prototype": {
      const prototype = new Proxy(Object.create(Buffer.prototype), {
        getPrototypeOf() { counter.count += 1; throw new Error("raw nested proxy trap"); },
      });
      Object.setPrototypeOf(value, prototype);
      return value;
    }
    case "proxy":
      return new Proxy(value, {
        getPrototypeOf() { counter.count += 1; throw new Error("raw proxy prototype trap"); },
        get() { counter.count += 1; throw new Error("raw proxy get trap"); },
        ownKeys() { counter.count += 1; throw new Error("raw proxy ownKeys trap"); },
        getOwnPropertyDescriptor() {
          counter.count += 1;
          throw new Error("raw proxy descriptor trap");
        },
      });
  }
}
