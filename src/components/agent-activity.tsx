"use client";

import { useSyncExternalStore } from "react";
import type { ActivityStore } from "@/features/webmcp/activity-store";
import type { RegistrationState } from "@/features/webmcp/tool-registration";

const statusCopy: Record<RegistrationState | "unsupported", string> = {
  unsupported: "Agent collaboration needs a supported environment. Manual use remains available.",
  registering: "Agent tools are updating for this page.",
  registered: "Agent tools ready for this page.",
  error: "Agent tool registration failed. Manual use remains available.",
  idle: "No Agent tools are available at this checkpoint.",
};

export function AgentActivity({
  store,
  status,
}: {
  store: ActivityStore;
  status: RegistrationState | "unsupported";
}) {
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <aside className="agent-activity" aria-label="Agent activity">
      <header>
        <span>Agent collaboration</span>
        <p aria-live="polite">{statusCopy[status]}</p>
      </header>
      {entries.length > 0 && (
        <ol aria-label="Recent Agent tool activity">
          {entries.slice(-20).map((entry, index) => (
            <li key={`${entry.startedAt}-${entry.name}-${index}`}>
              <strong>{entry.name}</strong>
              <span>{entry.success ? entry.stateChange : entry.errorCode ?? "Request failed"}</span>
              <span className="activity-duration">
                <time
                  aria-label={`Started ${new Date(entry.startedAt).toISOString()}`}
                  dateTime={new Date(entry.startedAt).toISOString()}
                >{new Date(entry.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                <span aria-hidden="true">–</span>
                <time
                  aria-label={`Ended ${new Date(entry.endedAt).toISOString()}`}
                  dateTime={new Date(entry.endedAt).toISOString()}
                >{new Date(entry.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
