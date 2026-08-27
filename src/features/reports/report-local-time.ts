const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function invalidLocalTime(): never {
  throw new RangeError("Invalid local date and time");
}

export function formatIsoForDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.valueOf())) return invalidLocalTime();
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseDateTimeLocalToIso(value: string): string {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) return invalidLocalTime();
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (year < 1) return invalidLocalTime();
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) return invalidLocalTime();
  return date.toISOString();
}

export function resolveDateTimeLocalIso(value: string, originalIso: string): string {
  return value === formatIsoForDateTimeLocal(originalIso)
    ? originalIso
    : parseDateTimeLocalToIso(value);
}
