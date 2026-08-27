import { DomainError } from "@/shared/domain-error";

export function formatWaitingDuration(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("CONFIGURATION_ERROR");
  if (value < 60_000) return "<1 min";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hr" : "hrs"}`;
  const days = Math.floor(hours / 24);
  return days > 999 ? "999+ days" : `${days} ${days === 1 ? "day" : "days"}`;
}

export function formatUtcTime(value: number): Readonly<{ dateTime: string; label: string }> {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("CONFIGURATION_ERROR");
  const dateTime = new Date(value).toISOString();
  return Object.freeze({
    dateTime,
    label: `${dateTime.slice(0, 10)} ${dateTime.slice(11, 19)} UTC`,
  });
}
