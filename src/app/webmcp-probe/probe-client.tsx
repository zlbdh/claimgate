"use client";

import { CheckCircle2, Info } from "lucide-react";
import { useEffect, useState } from "react";

import { resolveModelContext } from "@/features/webmcp/model-context";
import { registerCompatibilityProbe } from "@/features/webmcp/probe-tool";

type ProbeState = "registered" | "unavailable" | "error";

const statusCopy: Record<ProbeState, string> = {
  registered: "Native WebMCP probe registered and ready for an Agent call.",
  unavailable:
    "Agent collaboration needs ChatGPT's in-app browser or a supported Chrome test environment. Manual use remains available.",
  error:
    "The browser exposed WebMCP but rejected registration. Manual use remains available.",
};

export function ProbeClient() {
  const [probeState, setProbeState] = useState<ProbeState>("unavailable");
  const [manualReady, setManualReady] = useState(false);

  useEffect(() => {
    const resolved = resolveModelContext(document);
    if (!resolved.supported) return;

    const controller = new AbortController();
    let mounted = true;

    registerCompatibilityProbe(resolved.context, controller.signal).then(
      () => mounted && setProbeState("registered"),
      () => mounted && setProbeState("error"),
    );

    return () => {
      mounted = false;
      controller.abort();
    };
  }, []);

  const isRegistered = probeState === "registered";

  return (
    <div className="probe-controls">
      <div className={`compatibility-status status-${probeState}`} role="status">
        {isRegistered ? (
          <CheckCircle2 aria-hidden="true" size={20} />
        ) : (
          <Info aria-hidden="true" size={20} />
        )}
        <span>{statusCopy[probeState]}</span>
      </div>

      <div className="manual-check">
        <button type="button" onClick={() => setManualReady(true)}>
          Run manual readiness check
        </button>
        <p data-testid="hydration-result" aria-live="polite">
          {manualReady
            ? "Manual controls are ready."
            : "Manual controls work with or without Agent support."}
        </p>
      </div>
    </div>
  );
}
