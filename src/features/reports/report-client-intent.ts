type IntentState = Readonly<{ fingerprint: string; idempotencyKey: string }>;

export type ReportIntentRef = { current: IntentState | undefined };

export function attachReportIntentKey(
  businessBody: URLSearchParams,
  intentRef: ReportIntentRef,
  createKey: () => string = () => crypto.randomUUID(),
): URLSearchParams {
  const fingerprint = businessBody.toString();
  if (!intentRef.current || intentRef.current.fingerprint !== fingerprint) {
    intentRef.current = Object.freeze({ fingerprint, idempotencyKey: createKey() });
  }
  const body = new URLSearchParams(businessBody);
  body.set("idempotencyKey", intentRef.current.idempotencyKey);
  return body;
}
