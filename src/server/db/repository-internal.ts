import { DomainError } from "@/shared/domain-error";
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
  if (!value || value.length > 512) throw new DomainError("VALIDATION_FAILED");
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
  return row;
}

export function immediate<T>(context: RepositoryContext, operation: () => T): T {
  if (context.database.inTransaction) return operation();
  return context.database.transaction(operation).immediate();
}

export function rejectPromise(value: unknown): void {
  if (value && typeof value === "object" && "then" in value) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
}

export function rejectAsyncCallback(callback: (...args: never[]) => unknown): void {
  if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
    throw new DomainError("CONFIGURATION_ERROR");
  }
}

export function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  return parsed;
}

export function stateChanged(): never {
  throw new DomainError("STATE_CHANGED");
}
