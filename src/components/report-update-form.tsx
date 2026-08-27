"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PublicReportDto } from "@/features/reports/report-types";
import { attachReportIntentKey, type ReportIntentRef } from "@/features/reports/report-client-intent";
import {
  formatIsoForDateTimeLocal,
  resolveDateTimeLocalIso,
} from "@/features/reports/report-local-time";
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
  const intentRef = useRef<ReportIntentRef["current"]>(undefined);
  const inFlightRef = useRef(false);
  const timeFromRef = useRef<HTMLInputElement>(null);
  const timeToRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (timeFromRef.current) {
      timeFromRef.current.value = formatIsoForDateTimeLocal(report.timeWindow.from);
    }
    if (timeToRef.current) {
      timeToRef.current.value = formatIsoForDateTimeLocal(report.timeWindow.to);
    }
  }, [report.timeWindow.from, report.timeWindow.to]);

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
        expectedVersion: String(report.version),
        category: String(form.get("category") ?? ""),
        timeFrom: resolveDateTimeLocalIso(String(form.get("timeFrom") ?? ""), report.timeWindow.from),
        timeTo: resolveDateTimeLocalIso(String(form.get("timeTo") ?? ""), report.timeWindow.to),
        area: String(form.get("area") ?? ""),
        color: String(form.get("color") ?? ""),
        publicTags: JSON.stringify(tags),
        publicDescription: String(form.get("publicDescription") ?? ""),
      });
      const body = attachReportIntentKey(
        businessBody,
        { kind: "update", reportId: report.reportId },
        intentRef,
      );
      const response = await writer({
        path: `/api/reports/${report.reportId}`,
        csrfToken,
        body,
      });
      const result = await response.json() as {
        nextPath?: unknown;
        error?: { code?: unknown };
      };
      if (!response.ok) {
        if (response.status === 409 && result.error?.code === "STATE_CHANGED") {
          setError("STATE_CHANGED — This draft changed in another tab. Reload before trying again.");
          return;
        }
        throw new Error("request denied");
      }
      if (result.nextPath !== `/claimant/reports/${report.reportId}`) {
        throw new Error("invalid response");
      }
      intentRef.current = undefined;
      onNavigate(result.nextPath);
    } catch {
      setError("Changes could not be saved. Refresh the report and try again.");
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form className={`report-form ${className}`.trim()} aria-label="Update lost report draft" onSubmit={submit}>
      <div className="form-grid">
        <label>Category<input name="category" required maxLength={64} defaultValue={report.category} /></label>
        <label>From<input ref={timeFromRef} name="timeFrom" type="datetime-local" required defaultValue="" /></label>
        <label>To<input ref={timeToRef} name="timeTo" type="datetime-local" required defaultValue="" /></label>
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
