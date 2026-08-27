import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  formatIsoForDateTimeLocal,
  parseDateTimeLocalToIso,
  resolveDateTimeLocalIso,
} from "./report-local-time";

describe("datetime-local report helpers", () => {
  it("rejects malformed and calendar-normalized local values", () => {
    for (const value of ["", "2026-02-30T12:00", "2026-08-25T24:00", "2026-08-25T12:00Z"]) {
      expect(() => parseDateTimeLocalToIso(value)).toThrow("Invalid local date and time");
    }
  });

  it("round-trips genuine America/Los_Angeles local time and rejects the DST gap", () => {
    const script = `
      import reportTime from './src/features/reports/report-local-time.ts';
      const { formatIsoForDateTimeLocal, parseDateTimeLocalToIso, resolveDateTimeLocalIso } = reportTime;
      const original = '2026-08-25T17:00:37.123Z';
      let gap = 'accepted';
      try { parseDateTimeLocalToIso('2026-03-08T02:30'); } catch { gap = 'rejected'; }
      process.stdout.write(JSON.stringify({
        display: formatIsoForDateTimeLocal(original),
        unchanged: resolveDateTimeLocalIso(formatIsoForDateTimeLocal(original), original),
        changed: resolveDateTimeLocalIso('2026-08-25T11:00', original),
        gap,
      }));
    `;
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", script,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: "America/Los_Angeles" },
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      display: "2026-08-25T10:00",
      unchanged: "2026-08-25T17:00:37.123Z",
      changed: "2026-08-25T18:00:00.000Z",
      gap: "rejected",
    });
  });

  it("uses local date parts rather than slicing the UTC ISO", () => {
    const iso = "2026-08-25T17:00:37.123Z";
    const displayed = formatIsoForDateTimeLocal(iso);
    expect(displayed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(resolveDateTimeLocalIso(displayed, iso)).toBe(iso);
  });
});
