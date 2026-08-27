"use client";

import { useRef, useState, type FormEvent } from "react";
import { attachReportIntentKey, type ReportIntentRef } from "@/features/reports/report-client-intent";
import { parseDateTimeLocalToIso } from "@/features/reports/report-local-time";
import { performSameOriginWrite } from "@/server/http/same-origin-write";

type ReportWriter = typeof performSameOriginWrite;

export interface ReportCreateFormProps {
  csrfToken: string;
  writer?: ReportWriter;
  onNavigate?: (path: string) => void;
  className?: string;
}

export function ReportCreateForm({
  csrfToken,
  writer = performSameOriginWrite,
  onNavigate = (path) => window.location.assign(path),
  className = "",
}: ReportCreateFormProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const intentRef = useRef<ReportIntentRef["current"]>(undefined);
  const inFlightRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      const tags = String(form.get("publicDescriptors") ?? "")
        .split(",").map((tag) => tag.trim()).filter(Boolean);
      const businessBody = new URLSearchParams({
        category: String(form.get("category") ?? ""),
        timeFrom: parseDateTimeLocalToIso(String(form.get("timeFrom") ?? "")),
        timeTo: parseDateTimeLocalToIso(String(form.get("timeTo") ?? "")),
        area: String(form.get("area") ?? ""),
        color: String(form.get("color") ?? ""),
        publicTags: JSON.stringify(tags),
        publicDescription: String(form.get("publicDescription") ?? ""),
      });
      const body = attachReportIntentKey(businessBody, intentRef);
      const response = await writer({ path: "/api/reports", csrfToken, body });
      const result = await response.json() as { nextPath?: unknown };
      if (!response.ok || typeof result.nextPath !== "string" || !result.nextPath.startsWith("/claimant/reports/")) {
        throw new Error("invalid response");
      }
      intentRef.current = undefined;
      onNavigate(result.nextPath);
    } catch {
      setError("The draft could not be saved. Review the public fields and try again.");
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form className={`report-form compact-report-form ${className}`.trim()} aria-label="Create lost report draft" onSubmit={submit}>
      <div className="form-grid">
        <label>Category<input name="category" required maxLength={64} /></label>
        <label>From<input name="timeFrom" type="datetime-local" required /></label>
        <label>To<input name="timeTo" type="datetime-local" required /></label>
        <label>Area<input name="area" required maxLength={64} /></label>
        <label>Color<input name="color" required maxLength={64} /></label>
        <label className="wide-field">Public descriptors<input name="publicDescriptors" maxLength={256} placeholder="wireless, charging-case" /></label>
        <label className="wide-field">Public description<textarea name="publicDescription" required maxLength={256} rows={3} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save private draft"}</button>
    </form>
  );
}
