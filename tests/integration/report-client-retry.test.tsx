import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReportCreateForm } from "@/components/report-create-form";
import { ReportUpdateForm } from "@/components/report-update-form";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createReportService } from "@/features/reports/report-service";
import { createReportsRouteHandlers } from "@/app/api/reports/route";
import { createUpdateReportRouteHandler } from "@/app/api/reports/[reportId]/route";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";
import { resolveAuthenticatedRoute } from "@/server/http/authenticated-route-registry";
import type { performSameOriginWrite } from "@/server/http/same-origin-write";

const NOW = Date.UTC(2026, 7, 26, 12);
const ORIGIN = "https://example.test";
const SESSION_KEY = Buffer.alloc(32, 111).toString("base64");
const CSRF_KEY = Buffer.alloc(32, 112).toString("base64");
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  cleanup();
  testDatabase?.close();
  testDatabase = undefined;
});

function setup() {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const sessionSigner = createDemoSessionSigner({ key: SESSION_KEY, now: () => NOW });
  const csrf = createCsrfService({ key: CSRF_KEY, now: () => NOW });
  const signed = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role: "CLAIMANT",
    expiresAt: instance.expiresAtMs,
  });
  const dependencies = {
    appOrigin: parseAppOrigin(ORIGIN),
    repository: testDatabase.repository,
    limiter: createPersistentRateLimiter({ database: testDatabase.database, now: () => NOW }),
    sessionSigner,
    csrf,
    keyring: createKeyring(TEST_MASTER_KEY),
    now: () => NOW,
  };
  return {
    instance,
    signed,
    csrf,
    dependencies,
    cookie: `${DEMO_SESSION_COOKIE}=${signed.token}`,
  };
}

function mintCsrf(value: ReturnType<typeof setup>, path: string, routeKey: "api.reports.create" | "api.reports.update") {
  const resolved = resolveAuthenticatedRoute(new Request(`${ORIGIN}${path}`, { method: "POST" }), routeKey);
  return value.csrf.mint({
    sessionId: value.signed.claims.sessionId,
    method: "POST",
    routeId: resolved.csrfRouteId,
    action: routeKey === "api.reports.create" ? "draft_create" : "draft_update",
    oneTime: false,
    expiresAt: NOW + 60_000,
  });
}

function requestFromWrite(path: string, cookie: string, csrfToken: string, body: BodyInit) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "example.test",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie,
      "x-csrf-token": csrfToken,
    },
    body,
  });
}

function fillCreateForm() {
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: "earbuds" } });
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-25T17:00" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-25T19:00" } });
  fireEvent.change(screen.getByLabelText("Area"), { target: { value: "library" } });
  fireEvent.change(screen.getByLabelText("Color"), { target: { value: "black" } });
  fireEvent.change(screen.getByLabelText("Public descriptors"), { target: { value: "wireless, charging-case" } });
  fireEvent.change(screen.getByLabelText("Public description"), { target: { value: "Black earbud case." } });
}

describe("report client lost-response retries", () => {
  it("reuses the create idempotency key and returns the original single-write ack", async () => {
    const value = setup();
    const csrfToken = mintCsrf(value, "/api/reports", "api.reports.create");
    const handler = createReportsRouteHandlers(value.dependencies).POST;
    const keys: string[] = [];
    const acks: unknown[] = [];
    let attempt = 0;
    const writer: typeof performSameOriginWrite = async (input) => {
      const body = input.body as URLSearchParams;
      keys.push(body.get("idempotencyKey")!);
      const response = await handler(requestFromWrite(input.path, value.cookie, input.csrfToken, body));
      acks.push(await response.clone().json());
      attempt += 1;
      if (attempt === 1) throw new Error("response lost after commit");
      return response;
    };
    render(<ReportCreateForm csrfToken={csrfToken} writer={writer} onNavigate={() => undefined} />);
    fillCreateForm();
    const form = screen.getByRole("form", { name: "Create lost report draft" });

    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "  ＥＡＲＢＵＤＳ  " } });
    fireEvent.change(screen.getByLabelText("Area"), { target: { value: "  LIBRARY  " } });
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: " BLACK " } });
    fireEvent.change(screen.getByLabelText("Public descriptors"), {
      target: { value: "ＷＩＲＥＬＥＳＳ, charging–case" },
    });
    fireEvent.change(screen.getByLabelText("Public description"), {
      target: { value: "  Black   earbud case.  " },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(keys).toHaveLength(2));

    expect(keys[1]).toBe(keys[0]);
    expect(acks[1]).toEqual(acks[0]);
    expect(testDatabase!.repository.listLostReports(value.instance.demoInstanceId)).toHaveLength(1);
    expect(testDatabase!.repository.listAuditEvents(value.instance.demoInstanceId)
      .filter((event) => event.action === "REPORT_CREATED")).toHaveLength(1);
  });

  it("reuses the update idempotency key instead of failing stale after a lost response", async () => {
    const value = setup();
    const actor = {
      demoInstanceId: value.instance.demoInstanceId,
      actorId: value.signed.claims.userId,
      sessionExpiresAt: value.signed.claims.expiresAt,
    };
    const service = createReportService(value.dependencies);
    const created = service.createDraft(actor, {
      category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library",
      color: "black",
      publicTags: ["wireless"],
      publicDescription: "Black earbud case.",
      idempotencyKey: "initial-create-00000001",
    });
    const report = service.getOwned(actor, created.reportId);
    const path = `/api/reports/${created.reportId}`;
    const csrfToken = mintCsrf(value, path, "api.reports.update");
    const handler = createUpdateReportRouteHandler(value.dependencies);
    const keys: string[] = [];
    const acks: unknown[] = [];
    let attempt = 0;
    const writer: typeof performSameOriginWrite = async (input) => {
      const body = input.body as URLSearchParams;
      keys.push(body.get("idempotencyKey")!);
      const response = await handler(requestFromWrite(input.path, value.cookie, input.csrfToken, body));
      acks.push(await response.clone().json());
      attempt += 1;
      if (attempt === 1) throw new Error("response lost after commit");
      return response;
    };
    render(<ReportUpdateForm report={report} csrfToken={csrfToken} writer={writer} onNavigate={() => undefined} />);
    const form = screen.getByRole("form", { name: "Update lost report draft" });

    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: " ＥＡＲＢＵＤＳ " } });
    fireEvent.change(screen.getByLabelText("Area"), { target: { value: " LIBRARY " } });
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: " BLACK " } });
    fireEvent.change(screen.getByLabelText("Public descriptors"), { target: { value: "ＷＩＲＥＬＥＳＳ" } });
    fireEvent.change(screen.getByLabelText("Public description"), {
      target: { value: " Black   earbud case. " },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(keys).toHaveLength(2));

    expect(keys[1]).toBe(keys[0]);
    expect(acks[1]).toEqual(acks[0]);
    expect(acks[1]).toMatchObject({ status: "DRAFT", version: 2 });
    expect(service.getOwned(actor, created.reportId).version).toBe(2);
    expect(testDatabase!.repository.listAuditEvents(value.instance.demoInstanceId)
      .filter((event) => event.action === "REPORT_UPDATED")).toHaveLength(1);
  });
});
