"use client";

import { useState, type FormEvent } from "react";
import type { PublicReportDto } from "@/features/reports/report-types";
import { performSameOriginWrite } from "@/server/http/same-origin-write";

type ReportWriter = typeof performSameOriginWrite;

export interface ReportUpdateFormProps {
  csrfToken: string;
  report: PublicReportDto;
  writer?: ReportWriter;
  onNavigate?: (path: string) => void;
  className?: string;
}

export function ReportUpdateForm({
  csrfToken,
  report,
  writer = performSameOriginWrite,
  onNavigate = (path) => window.location.assign(path),
  className = "",
}: ReportUpdateFormProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      const tags = String(form.get("publicDescriptors") ?? "")
        .split(",").map((tag) => tag.trim()).filter(Boolean);
      const body = new URLSearchParams({
        expectedVersion: String(report.version),
        category: String(form.get("category") ?? ""),
        timeFrom: new Date(String(form.get("timeFrom") ?? "")).toISOString(),
        timeTo: new Date(String(form.get("timeTo") ?? "")).toISOString(),
        area: String(form.get("area") ?? ""),
        color: String(form.get("color") ?? ""),
        publicTags: JSON.stringify(tags),
        publicDescription: String(form.get("publicDescription") ?? ""),
        idempotencyKey: crypto.randomUUID(),
      });
      const response = await writer({
        path: `/api/reports/${report.reportId}`,
        csrfToken,
        body,
      });
      const result = await response.json() as { nextPath?: unknown };
      if (!response.ok || result.nextPath !== `/claimant/reports/${report.reportId}`) {
        throw new Error("invalid response");
      }
      onNavigate(result.nextPath);
    } catch {
      setError("Changes could not be saved. Refresh the report and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`report-form ${className}`.trim()} aria-label="Update lost report draft" onSubmit={submit}>
      <div className="form-grid">
        <label>Category<input name="category" required maxLength={64} defaultValue={report.category} /></label>
        <label>From<input name="timeFrom" type="datetime-local" required defaultValue={report.timeWindow.from.slice(0, 16)} /></label>
        <label>To<input name="timeTo" type="datetime-local" required defaultValue={report.timeWindow.to.slice(0, 16)} /></label>
        <label>Area<input name="area" required maxLength={64} defaultValue={report.area} /></label>
        <label>Color<input name="color" required maxLength={64} defaultValue={report.color} /></label>
        <label className="wide-field">Public descriptors<input name="publicDescriptors" maxLength={256} defaultValue={report.publicTags.join(", ")} /></label>
        <label className="wide-field">Public description<textarea name="publicDescription" required maxLength={256} rows={4} defaultValue={report.publicDescription} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
    </form>
  );
}
