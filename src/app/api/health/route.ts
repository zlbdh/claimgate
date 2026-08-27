import type Database from "better-sqlite3";

export const dynamic = "force-dynamic";

type HealthDatabase = Pick<Database.Database, "prepare">;

const RESPONSE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
});

function healthResponse(status: "healthy" | "unavailable"): Response {
  return Response.json({ status }, {
    status: status === "healthy" ? 200 : 503,
    headers: RESPONSE_HEADERS,
  });
}

function assertDatabaseConnectivity(database: HealthDatabase): void {
  const row = database.prepare("SELECT 1 AS ready").get() as unknown;
  if (
    typeof row !== "object"
    || row === null
    || Object.keys(row).length !== 1
    || !Object.hasOwn(row, "ready")
    || (row as { ready?: unknown }).ready !== 1
  ) throw new Error("Database health query failed");
}

export function createHealthRouteHandler(getDatabase: () => HealthDatabase) {
  return function health(): Response {
    try {
      assertDatabaseConnectivity(getDatabase());
      return healthResponse("healthy");
    } catch {
      return healthResponse("unavailable");
    }
  };
}

export async function GET(): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createHealthRouteHandler(() => getHttpRuntime().database)();
  } catch {
    return healthResponse("unavailable");
  }
}
