import "server-only";

import { Buffer } from "node:buffer";
import {
  createHmac,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import { cloneStandardPickupBuffer } from "./standard-pickup-buffer";

const PURPOSE = Buffer.from("ClaimGate/pickup-pass/v1", "utf8");
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type PickupPassBinding = Readonly<{
  demoInstanceId: string;
  claimId: string;
  generation: number;
  expiresAtMs: number;
}>;

type PickupPassDigestInput = PickupPassBinding & Readonly<{
  salt: Buffer;
  tokenBytes: Buffer;
}>;

type PickupPassVerifyInput = PickupPassBinding & Readonly<{
  salt: Buffer;
  digest: Buffer;
  token: string;
}>;

function requireBinding(input: PickupPassBinding): void {
  if (
    !input
    || typeof input.demoInstanceId !== "string"
    || input.demoInstanceId.length < 1
    || input.demoInstanceId.length > 512
    || typeof input.claimId !== "string"
    || input.claimId.length < 1
    || input.claimId.length > 512
    || !Number.isSafeInteger(input.generation)
    || input.generation < 1
    || !Number.isSafeInteger(input.expiresAtMs)
    || input.expiresAtMs < 1
  ) throw new DomainError("VALIDATION_FAILED");
}

function lengthPrefix(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function safeIntegerBytes(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

export function parsePickupPassToken(value: unknown): Buffer {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new DomainError("VALIDATION_FAILED");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 16 || decoded.toString("base64url") !== value) {
    throw new DomainError("VALIDATION_FAILED");
  }
  return decoded;
}

export function createPickupPassCrypto(
  keyInput: Buffer,
  options: Readonly<{
    randomBytes?: (size: number) => Buffer;
    compareDigests?: (left: Buffer, right: Buffer) => boolean;
  }> = {},
) {
  const key = cloneStandardPickupBuffer(keyInput, 32);
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const compareDigests = options.compareDigests ?? timingSafeEqual;
  if (typeof randomBytes !== "function" || typeof compareDigests !== "function") {
    throw new DomainError("CONFIGURATION_ERROR");
  }

  const digest = (input: PickupPassDigestInput): Buffer => {
    requireBinding(input);
    const salt = cloneStandardPickupBuffer(input.salt, 32);
    const tokenBytes = cloneStandardPickupBuffer(input.tokenBytes, 16);
    return createHmac("sha256", key).update(Buffer.concat([
      lengthPrefix(PURPOSE),
      lengthPrefix(salt),
      lengthPrefix(Buffer.from(input.demoInstanceId, "utf8")),
      lengthPrefix(Buffer.from(input.claimId, "utf8")),
      lengthPrefix(safeIntegerBytes(input.generation)),
      lengthPrefix(safeIntegerBytes(input.expiresAtMs)),
      lengthPrefix(tokenBytes),
    ])).digest();
  };

  return Object.freeze({
    digest,
    issue(binding: PickupPassBinding) {
      requireBinding(binding);
      const tokenBytes = cloneStandardPickupBuffer(randomBytes(16), 16);
      const salt = cloneStandardPickupBuffer(randomBytes(32), 32);
      const token = tokenBytes.toString("base64url");
      if (token.length !== 22 || parsePickupPassToken(token).length !== 16) {
        throw new DomainError("CONFIGURATION_ERROR");
      }
      return Object.freeze({
        token,
        salt,
        digest: digest({ ...binding, salt, tokenBytes }),
      });
    },
    verify(input: PickupPassVerifyInput): boolean {
      const tokenBytes = parsePickupPassToken(input.token);
      const supplied = cloneStandardPickupBuffer(input.digest, 32);
      const expected = digest({ ...input, tokenBytes });
      const matches = compareDigests(expected, supplied);
      if (typeof matches !== "boolean") throw new DomainError("CONFIGURATION_ERROR");
      return matches;
    },
  });
}

export type PickupPassCrypto = ReturnType<typeof createPickupPassCrypto>;
