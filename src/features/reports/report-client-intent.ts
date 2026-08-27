import { DomainError } from "@/shared/domain-error";
import { createReportFingerprint, updateReportFingerprint } from "./report-fingerprint";
import { parseCreateReportForm, parseUpdateReportForm } from "./report-schema";

type IntentState = Readonly<{ fingerprint: string; idempotencyKey: string }>;

export type ReportIntentRef = { current: IntentState | undefined };
export type ReportIntentContext =
  | Readonly<{ kind: "create" }>
  | Readonly<{ kind: "update"; reportId: string }>;

const PARSER_PLACEHOLDER_KEY = "client-intent-placeholder-v1";

function parserEntries(businessBody: URLSearchParams): ReadonlyArray<readonly [string, string]> {
  return [...businessBody.entries(), ["idempotencyKey", PARSER_PLACEHOLDER_KEY] as const];
}

export function reportClientIntentFingerprint(
  businessBody: URLSearchParams,
  context: ReportIntentContext,
): string {
  if (context.kind === "create") {
    return createReportFingerprint(parseCreateReportForm(parserEntries(businessBody)));
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(context.reportId)) {
    throw new DomainError("VALIDATION_FAILED");
  }
  return updateReportFingerprint(
    context.reportId,
    parseUpdateReportForm(parserEntries(businessBody)),
  );
}

export function attachReportIntentKey(
  businessBody: URLSearchParams,
  context: ReportIntentContext,
  intentRef: ReportIntentRef,
  createKey: () => string = () => crypto.randomUUID(),
): URLSearchParams {
  const fingerprint = reportClientIntentFingerprint(businessBody, context);
  if (!intentRef.current || intentRef.current.fingerprint !== fingerprint) {
    intentRef.current = Object.freeze({ fingerprint, idempotencyKey: createKey() });
  }
  const body = new URLSearchParams(businessBody);
  body.set("idempotencyKey", intentRef.current.idempotencyKey);
  return body;
}
