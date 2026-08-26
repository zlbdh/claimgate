import { DomainError } from "@/shared/domain-error";
import type { DomainErrorCode } from "@/shared/domain-error";
import { DEMO_IDENTITIES, isDemoUserId, type DemoUserId } from "@/shared/demo-identity";
import type { DemoInstance, RepositoryContext } from "./repository-types";

type DemoInstanceRow = {
  demoInstanceId: string;
  createdAtMs: number;
  expiresAtMs: number;
  catalogVersion: number;
};

export function requireInteger(value: number, positive = false): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || (positive && value <= 0)) {
    throw new DomainError("VALIDATION_FAILED");
  }
}

export function requireText(value: string): void {
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new DomainError("VALIDATION_FAILED");
  }
}

type PublicActorId = DemoUserId;
type ActorId = "system" | PublicActorId;

export function requireActor(value: string, allowSystem: true): ActorId;
export function requireActor(value: string, allowSystem?: false): PublicActorId;
export function requireActor(value: string, allowSystem = false): ActorId {
  if (typeof value !== "string" || (!(allowSystem && value === "system") && !isDemoUserId(value))) {
    throw new DomainError("VALIDATION_FAILED");
  }
  return value as ActorId;
}

export const CLAIMANT_ACTOR_ID = DEMO_IDENTITIES.CLAIMANT.userId;
export const STAFF_ACTOR_ID = DEMO_IDENTITIES.STAFF.userId;

export function requirePatchKeys(value: object, allowedKeys: readonly string[]): void {
  if (
    Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  ) {
    throw new DomainError("INVALID_STATE_TRANSITION");
  }
}

export function activeInstance(context: RepositoryContext, demoInstanceId: string): DemoInstance {
  requireText(demoInstanceId);
  const now = context.now();
  requireInteger(now);
  const row = context.database.prepare(`
    SELECT id AS demoInstanceId, created_at_ms AS createdAtMs,
      expires_at_ms AS expiresAtMs, catalog_version AS catalogVersion
    FROM demo_instances WHERE id = ? AND expires_at_ms > ?
  `).get(demoInstanceId, now) as DemoInstanceRow | undefined;
  if (!row) throw new DomainError("NOT_FOUND");
  assertNoInternalInventoryIdentity(context, row, "CONFIGURATION_ERROR");
  return row;
}

export function immediate<T>(context: RepositoryContext, operation: () => T): T {
  if (context.database.inTransaction) return operation();
  return context.database.transaction(operation).immediate();
}

export function rejectPromise(value: unknown): void {
  if (value && typeof value === "object" && "then" in value) {
    void Promise.resolve(value).catch(() => undefined);
    throw new DomainError("CONFIGURATION_ERROR");
  }
}

export function rejectAsyncCallback(callback: (...args: never[]) => unknown): void {
  if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
    throw new DomainError("CONFIGURATION_ERROR");
  }
}

export function assertNoInternalInventoryIdentity(
  context: RepositoryContext,
  value: unknown,
  code: DomainErrorCode,
): void {
  const internalIds = (context.database.prepare(
    "SELECT id FROM found_items",
  ).all() as Array<{ id: string }>).map(({ id }) => id);
  const seen = new Set<object>();
  const inspect = (entry: unknown): void => {
    if (typeof entry === "string") {
      if (internalIds.some((id) => entry.includes(id))) throw new DomainError(code);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    if (seen.has(entry)) throw new DomainError(code);
    seen.add(entry);
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key === "symbol") throw new DomainError(code);
      inspect(key);
      inspect(Reflect.get(entry, key));
    }
  };
  inspect(value);
}

export function validatePublicTags(value: unknown, code: DomainErrorCode): string[] {
  if (
    !Array.isArray(value)
    || value.length > 16
    || !value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 64)
  ) {
    throw new DomainError(code);
  }
  return [...value];
}

export function parseStringArray(value: string): string[] {
  try {
    return validatePublicTags(JSON.parse(value) as unknown, "CONFIGURATION_ERROR");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("CONFIGURATION_ERROR");
  }
}

export function stateChanged(): never {
  throw new DomainError("STATE_CHANGED");
}
