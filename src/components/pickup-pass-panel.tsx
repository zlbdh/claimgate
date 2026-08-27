"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type { ClaimStatus } from "@/features/claims/claim-state";
import { parsePickupIssuanceClientResponse } from "@/features/claims/pickup-pass-client-response";

type Credential = Readonly<{
  token: string;
  generation: number;
  expiresAtMs: number;
  epoch: number;
  identity: string;
}>;
type UiMessage = Readonly<{ text: string; epoch: number; identity: string }>;

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
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
  const identity = `${props.claimId}\0${props.status}\0${props.claimVersion}`;
  const identityRef = useRef(identity);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tokenRef = useRef<string | undefined>(undefined);
  const credentialRef = useRef<Credential | undefined>(undefined);
  const mountedRef = useRef(false);
  const epochRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const [credential, setCredential] = useState<Credential>();
  const [revealed, setRevealed] = useState(false);
  const [message, setMessage] = useState<UiMessage>();
  const [pending, setPending] = useState<{ epoch: number; identity: string }>();
  const [viewEpoch, setViewEpoch] = useState(0);
  const [stateIdentity, setStateIdentity] = useState(identity);
  const [keys] = useState(() => ({ issue: crypto.randomUUID(), reissue: crypto.randomUUID() }));

  if (stateIdentity !== identity) {
    setStateIdentity(identity);
    setViewEpoch(viewEpoch + 1);
    setCredential(undefined);
    setRevealed(false);
    setMessage(undefined);
    setPending(undefined);
  }

  const invalidate = useCallback((updateState: boolean) => {
    epochRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    tokenRef.current = undefined;
    credentialRef.current = undefined;
    clearCanvas(canvasRef.current);
    if (updateState && mountedRef.current) {
      setViewEpoch(epochRef.current);
      setRevealed(false);
      setCredential(undefined);
      setMessage(undefined);
      setPending(undefined);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; invalidate(false); };
  }, [invalidate]);

  useEffect(() => {
    const clear = () => invalidate(true);
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", clear);
    window.addEventListener("popstate", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", clear);
      window.removeEventListener("popstate", clear);
    };
  }, [invalidate]);

  useLayoutEffect(() => {
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      invalidate(false);
    }
  }, [identity, invalidate]);

  const currentRequest = useCallback((epoch: number, controller: AbortController, requestIdentity: string) => (
    mountedRef.current && epochRef.current === epoch
    && controllerRef.current === controller && !controller.signal.aborted
    && identityRef.current === requestIdentity
  ), []);

  useEffect(() => {
    if (!credential || credential !== credentialRef.current || credential.identity !== identity) return;
    const visible = canvasRef.current;
    if (!visible) return;
    const detached = document.createElement("canvas");
    detached.width = 224;
    detached.height = 224;
    const stillCurrent = () => mountedRef.current
      && epochRef.current === credential.epoch
      && identityRef.current === credential.identity
      && credentialRef.current === credential;
    const displayError = (text: string) => {
      invalidate(true);
      if (mountedRef.current) setMessage({ text, epoch: epochRef.current, identity: identityRef.current });
    };
    try {
      void QRCode.toCanvas(detached, credential.token, {
        width: 224, margin: 2, errorCorrectionLevel: "M",
        color: { dark: "#10233f", light: "#fffdf6" },
      }).then(() => {
        if (!stillCurrent()) return;
        const context = visible.getContext("2d");
        if (!context) throw new Error("canvas unavailable");
        visible.width = detached.width;
        visible.height = detached.height;
        context.clearRect(0, 0, visible.width, visible.height);
        context.drawImage(detached, 0, 0);
      }).catch(() => { if (stillCurrent()) displayError("The QR credential could not be drawn. Reload before trying again."); });
      const remaining = credential.expiresAtMs - Date.now();
      timerRef.current = setTimeout(() => {
        if (stillCurrent()) displayError("This pickup credential expired. Use the explicit Reissue control after reloading.");
      }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    } catch {
      if (stillCurrent()) displayError("The credential display could not be scheduled. Reload before trying again.");
    }
    return () => {
      detached.width = 0;
      detached.height = 0;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
      clearCanvas(visible);
    };
  }, [credential, identity, invalidate]);

  async function submit(action: "issue" | "reissue", event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invalidate(true);
    const requestIdentity = identityRef.current;
    const epoch = epochRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!mountedRef.current) return;
    setPending({ epoch, identity: requestIdentity });
    setMessage({
      text: action === "issue" ? "Generating one-time credential…" : "Reissuing credential…",
      epoch, identity: requestIdentity,
    });
    const csrfToken = action === "issue" ? props.issueCsrfToken : props.reissueCsrfToken;
    const path = `/api/claims/${props.claimId}/pickup-pass/${action}`;
    try {
      if (!csrfToken) throw new Error("missing csrf");
      const response = await (props.fetcher ?? fetch)(path, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-CSRF-Token": csrfToken,
        },
        body: new URLSearchParams({
          expectedClaimVersion: String(props.claimVersion), idempotencyKey: keys[action],
        }),
      });
      if (!currentRequest(epoch, controller, requestIdentity)) return;
      const text = await response.text();
      if (!currentRequest(epoch, controller, requestIdentity)) return;
      if (!response.ok || text.length > 1_024) throw new Error("request failed");
      const result = parsePickupIssuanceClientResponse(JSON.parse(text) as unknown, {
        claimId: props.claimId,
        currentClaimVersion: props.claimVersion,
        expectedGeneration: action === "issue" ? 1 : (props.generation ?? 0) + 1,
        now: Date.now(),
      });
      if (!currentRequest(epoch, controller, requestIdentity)) return;
      if (result.issuance === "ALREADY_ISSUED") {
        setMessage({
          text: "Already issued: the original credential cannot be recovered. Reload, then use Reissue explicitly.",
          epoch, identity: requestIdentity,
        });
        return;
      }
      const next: Credential = {
        token: result.token, generation: result.generation, expiresAtMs: result.expiresAtMs,
        epoch, identity: requestIdentity,
      };
      credentialRef.current = next;
      tokenRef.current = next.token;
      setCredential(next);
      setMessage({
        text: "One-time credential ready. Keep this page open until Staff completes handoff.",
        epoch, identity: requestIdentity,
      });
    } catch {
      if (!currentRequest(epoch, controller, requestIdentity)) return;
      tokenRef.current = undefined;
      credentialRef.current = undefined;
      clearCanvas(canvasRef.current);
      setCredential(undefined);
      setRevealed(false);
      setMessage({
        text: "The credential response was invalid or unavailable. Reload; never auto-reissue a lost response.",
        epoch, identity: requestIdentity,
      });
    } finally {
      if (currentRequest(epoch, controller, requestIdentity)) {
        controllerRef.current = undefined;
        setPending(undefined);
      }
    }
  }

  const activeCredential = credential?.identity === identity && credential.epoch === viewEpoch
    ? credential : undefined;
  const activeMessage = message?.identity === identity && message.epoch === viewEpoch
    ? message.text : undefined;
  const isPending = pending?.identity === identity && pending.epoch === viewEpoch;
  const safeExpiry = activeCredential?.expiresAtMs ?? props.expiresAtMs;
  const safeGeneration = activeCredential?.generation ?? props.generation;
  return (
    <section className="pickup-pass-panel" aria-labelledby="pickup-pass-title">
      <p className="workspace-kicker">One-time human credential</p>
      <h2 id="pickup-pass-title">Pickup pass</h2>
      <p>Present this credential only at Desk 04. It is consumed by a successful handoff.</p>
      {(safeGeneration || safeExpiry) && <dl className="pickup-pass-meta">
        {safeGeneration && <div><dt>Generation</dt><dd>{safeGeneration}</dd></div>}
        {safeExpiry && <div><dt>Expires</dt><dd>{new Date(safeExpiry).toISOString()}</dd></div>}
      </dl>}
      {props.status === "APPROVED" && props.issueCsrfToken && !activeCredential && (
        <form onSubmit={(event) => submit("issue", event)}>
          <button disabled={isPending} type="submit">Generate pickup pass</button>
        </form>
      )}
      {props.status === "PICKUP_READY" && props.reissueCsrfToken && !activeCredential && (
        <form onSubmit={(event) => submit("reissue", event)}>
          <button className="quiet-action" disabled={isPending} type="submit">Reissue pickup pass</button>
        </form>
      )}
      {activeCredential && <div className="pickup-credential" aria-live="polite">
        <canvas ref={canvasRef} width={0} height={0} aria-label="Pickup credential QR code" />
        <code>{revealed ? activeCredential.token : "•••• •••• •••• •••• •••• ••"}</code>
        <div className="manual-actions">
          <button type="button" onClick={() => setRevealed((value) => !value)}>
            {revealed ? "Mask credential" : "Reveal credential"}
          </button>
          <button className="quiet-action" type="button" onClick={() => {
            if (tokenRef.current) void navigator.clipboard?.writeText(tokenRef.current);
          }}>Copy credential</button>
        </div>
      </div>}
      {activeMessage && <p className="workspace-state" role="status">{activeMessage}</p>}
    </section>
  );
}
