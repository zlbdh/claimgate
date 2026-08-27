"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type { ClaimStatus } from "@/features/claims/claim-state";

type Credential = Readonly<{
  token: string;
  claimVersion: number;
  generation: number;
  expiresAtMs: number;
}>;

function canonicalToken(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(value)
    && value.length === 22;
}

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
}

export function PickupPassPanel(props: {
  claimId: string;
  status: ClaimStatus;
  claimVersion: number;
  generation?: number;
  expiresAtMs?: number | null;
  issueCsrfToken?: string;
  reissueCsrfToken?: string;
  fetcher?: typeof fetch;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tokenRef = useRef<string | undefined>(undefined);
  const [credential, setCredential] = useState<Credential>();
  const [revealed, setRevealed] = useState(false);
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const [keys] = useState(() => ({ issue: crypto.randomUUID(), reissue: crypto.randomUUID() }));

  const clearCredential = useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    tokenRef.current = undefined;
    clearCanvas(canvasRef.current);
    setRevealed(false);
    setCredential(undefined);
  }, []);

  useEffect(() => {
    const clear = () => clearCredential();
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", clear);
    window.addEventListener("popstate", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", clear);
      window.removeEventListener("popstate", clear);
      clearCredential();
    };
  }, [clearCredential]);

  useEffect(() => {
    if (!credential || !canvasRef.current) return;
    const canvas = canvasRef.current;
    tokenRef.current = credential.token;
    void QRCode.toCanvas(canvas, credential.token, {
      width: 224,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#10233f", light: "#fffdf6" },
    }).catch(() => {
      clearCredential();
      setMessage("The QR credential could not be drawn. Reload before trying again.");
    });
    const remaining = credential.expiresAtMs - Date.now();
    if (remaining <= 0) {
      timerRef.current = setTimeout(() => {
        clearCredential();
        setMessage("This pickup credential expired. Use the explicit Reissue control after reloading.");
      }, 0);
      return;
    }
    timerRef.current = setTimeout(() => {
      clearCredential();
      setMessage("This pickup credential expired. Use the explicit Reissue control after reloading.");
    }, Math.min(remaining, 2_147_483_647));
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
      clearCanvas(canvas);
    };
  }, [credential, clearCredential]);

  async function submit(action: "issue" | "reissue", event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearCredential();
    setPending(true);
    setMessage(action === "issue" ? "Generating one-time credential…" : "Reissuing credential…");
    const csrfToken = action === "issue" ? props.issueCsrfToken : props.reissueCsrfToken;
    const path = `/api/claims/${props.claimId}/pickup-pass/${action}`;
    try {
      if (!csrfToken) throw new Error("missing csrf");
      const response = await (props.fetcher ?? fetch)(path, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-CSRF-Token": csrfToken,
        },
        body: new URLSearchParams({
          expectedClaimVersion: String(props.claimVersion),
          idempotencyKey: keys[action],
        }),
      });
      const text = await response.text();
      if (!response.ok || text.length > 1_024) throw new Error("request failed");
      const result = JSON.parse(text) as Record<string, unknown>;
      if (result.issuance === "ALREADY_ISSUED") {
        setMessage("Already issued: the original credential cannot be recovered. Reload, then use Reissue explicitly.");
        return;
      }
      if (
        result.issuance !== "ISSUED"
        || !canonicalToken(result.token)
        || !Number.isSafeInteger(result.claimVersion)
        || !Number.isSafeInteger(result.generation)
        || !Number.isSafeInteger(result.expiresAtMs)
      ) throw new Error("invalid response");
      setCredential({
        token: result.token,
        claimVersion: result.claimVersion as number,
        generation: result.generation as number,
        expiresAtMs: result.expiresAtMs as number,
      });
      setMessage("One-time credential ready. Keep this page open until Staff completes handoff.");
    } catch {
      clearCredential();
      setMessage("The credential response was not available. Reload; never auto-reissue a lost response.");
    } finally {
      setPending(false);
    }
  }

  const safeExpiry = credential?.expiresAtMs ?? props.expiresAtMs;
  const safeGeneration = credential?.generation ?? props.generation;
  return (
    <section className="pickup-pass-panel" aria-labelledby="pickup-pass-title">
      <p className="workspace-kicker">One-time human credential</p>
      <h2 id="pickup-pass-title">Pickup pass</h2>
      <p>Present this credential only at Desk 04. It is consumed by a successful handoff.</p>
      {(safeGeneration || safeExpiry) && <dl className="pickup-pass-meta">
        {safeGeneration && <div><dt>Generation</dt><dd>{safeGeneration}</dd></div>}
        {safeExpiry && <div><dt>Expires</dt><dd>{new Date(safeExpiry).toISOString()}</dd></div>}
      </dl>}
      {props.status === "APPROVED" && props.issueCsrfToken && !credential && (
        <form onSubmit={(event) => submit("issue", event)}>
          <button disabled={pending} type="submit">Generate pickup pass</button>
        </form>
      )}
      {props.status === "PICKUP_READY" && props.reissueCsrfToken && !credential && (
        <form onSubmit={(event) => submit("reissue", event)}>
          <button className="quiet-action" disabled={pending} type="submit">Reissue pickup pass</button>
        </form>
      )}
      {credential && <div className="pickup-credential" aria-live="polite">
        <canvas ref={canvasRef} aria-label="Pickup credential QR code" />
        <code>{revealed ? credential.token : "•••• •••• •••• •••• •••• ••"}</code>
        <div className="manual-actions">
          <button type="button" onClick={() => setRevealed((value) => !value)}>
            {revealed ? "Mask credential" : "Reveal credential"}
          </button>
          <button className="quiet-action" type="button" onClick={() => {
            if (tokenRef.current) void navigator.clipboard?.writeText(tokenRef.current);
          }}>Copy credential</button>
        </div>
      </div>}
      {message && <p className="workspace-state" role="status">{message}</p>}
    </section>
  );
}
