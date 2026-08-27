import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { PickupPassPanel } from "./pickup-pass-panel";
import { StaffHandoffForm } from "./staff-handoff-form";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn() } }));

const TOKEN_A = "abcdefghijklmnopqrstuA";
const TOKEN_B = "abcdefghijklmnopqrstuQ";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function issuance(token = TOKEN_A, overrides: Record<string, unknown> = {}) {
  return Response.json({
    issuance: "ISSUED", claimId: "claim-ui", status: "PICKUP_READY",
    claimVersion: 6, generation: 1, expiresAtMs: Date.now() + 60_000, token,
    ...overrides,
  });
}

function panel(fetcher: typeof fetch) {
  return <PickupPassPanel
    claimId="claim-ui" status="APPROVED" claimVersion={5}
    issueCsrfToken="csrf-issue" fetcher={fetcher}
  />;
}

async function resolveResponse(
  pending: ReturnType<typeof deferred<Response>>,
  response = issuance(),
) {
  await act(async () => {
    pending.resolve(response);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("pickup request and QR generation gates", () => {
  const clearRect = vi.fn();
  const drawImage = vi.fn();

  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    clearRect.mockClear();
    drawImage.mockClear();
    vi.mocked(QRCode.toCanvas).mockReset().mockResolvedValue(undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect, drawImage,
    } as never);
  });

  it.each(["pagehide", "pageshow", "popstate"])(
    "aborts and ignores a delayed response after %s",
    async (eventName) => {
      const pending = deferred<Response>();
      const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        void input; void init; return pending.promise;
      });
      const { container } = render(panel(fetcher as typeof fetch));
      fireEvent.submit(screen.getByRole("button", { name: /generate pickup pass/i }).closest("form")!);
      const signal = (fetcher.mock.calls[0]![1] as RequestInit).signal!;
      window.dispatchEvent(new Event(eventName));
      expect(signal.aborted).toBe(true);
      await resolveResponse(pending);
      expect(container.textContent).not.toContain(TOKEN_A);
      expect(container.querySelector("canvas")?.width ?? 0).toBe(0);
      expect(QRCode.toCanvas).not.toHaveBeenCalled();
    },
  );

  it("aborts and ignores a delayed response after unmount", async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init; return pending.promise;
    });
    const { unmount } = render(panel(fetcher as typeof fetch));
    fireEvent.submit(screen.getByRole("button", { name: /generate pickup pass/i }).closest("form")!);
    const signal = (fetcher.mock.calls[0]![1] as RequestInit).signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await resolveResponse(pending);
    expect(QRCode.toCanvas).not.toHaveBeenCalled();
  });

  it.each([
    { claimId: "claim-other" },
    { claimVersion: 6 },
    { status: "PICKUP_READY" as const },
  ])("invalidates a delayed response after prop change %#", async (changed) => {
    const pending = deferred<Response>();
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init; return pending.promise;
    });
    const props = {
      claimId: "claim-ui", status: "APPROVED" as const, claimVersion: 5,
      issueCsrfToken: "csrf-issue", fetcher: fetcher as typeof fetch,
    };
    const { container, rerender } = render(<PickupPassPanel {...props} />);
    fireEvent.submit(screen.getByRole("button", { name: /generate pickup pass/i }).closest("form")!);
    const signal = (fetcher.mock.calls[0]![1] as RequestInit).signal!;
    rerender(<PickupPassPanel {...props} {...changed} />);
    expect(signal.aborted).toBe(true);
    await resolveResponse(pending);
    expect(container.textContent).not.toContain(TOKEN_A);
    expect(container.querySelector("canvas")?.width ?? 0).toBe(0);
  });

  it("keeps the newest response when two requests resolve in reverse order", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetcher = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { container } = render(panel(fetcher as typeof fetch));
    const form = screen.getByRole("button", { name: /generate pickup pass/i }).closest("form")!;
    fireEvent.submit(form);
    const firstSignal = (fetcher.mock.calls[0]![1] as RequestInit).signal!;
    fireEvent.submit(form);
    expect(firstSignal.aborted).toBe(true);
    await resolveResponse(second, issuance(TOKEN_B));
    await resolveResponse(first, issuance(TOKEN_A));
    fireEvent.click(screen.getByRole("button", { name: /reveal credential/i }));
    expect(container.textContent).toContain(TOKEN_B);
    expect(container.textContent).not.toContain(TOKEN_A);
  });

  it("does not resurrect a revealed credential after identity A to B to A", async () => {
    const clipboard = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: clipboard },
    });
    const props = {
      claimId: "claim-ui", status: "APPROVED" as const, claimVersion: 5,
      issueCsrfToken: "csrf", fetcher: vi.fn(async () => issuance()) as typeof fetch,
    };
    const { container, rerender } = render(<PickupPassPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
    await waitFor(() => expect(drawImage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /reveal credential/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy credential/i }));
    expect(clipboard).toHaveBeenCalledWith(TOKEN_A);
    rerender(<PickupPassPanel {...props} claimId="claim-other" />);
    rerender(<PickupPassPanel {...props} />);
    expect(container.textContent).not.toContain(TOKEN_A);
    expect(container.querySelector("canvas")?.width ?? 0).toBe(0);
    expect(screen.queryByRole("button", { name: /copy credential/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/credential ready/i)).not.toBeInTheDocument();
    expect(clipboard).toHaveBeenCalledOnce();
  });

  it("does not resurrect pending or message state after identity A to B to A", () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init; return pending.promise;
    });
    const props = {
      claimId: "claim-ui", status: "APPROVED" as const, claimVersion: 5,
      issueCsrfToken: "csrf", fetcher: fetcher as typeof fetch,
    };
    const { rerender } = render(<PickupPassPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
    expect(screen.getByRole("button", { name: /generate pickup pass/i })).toBeDisabled();
    expect(screen.getByText(/generating one-time credential/i)).toBeVisible();
    rerender(<PickupPassPanel {...props} claimId="claim-other" />);
    rerender(<PickupPassPanel {...props} />);
    expect(screen.getByRole("button", { name: /generate pickup pass/i })).toBeEnabled();
    expect(screen.queryByText(/generating one-time credential/i)).not.toBeInTheDocument();
  });

  it("renders on a detached canvas and discards a delayed renderer after clear", async () => {
    const renderer = deferred<void>();
    vi.mocked(QRCode.toCanvas).mockImplementationOnce(() => renderer.promise as never);
    const fetcher = vi.fn(async () => issuance());
    const { container } = render(panel(fetcher as typeof fetch));
    fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
    await waitFor(() => expect(QRCode.toCanvas).toHaveBeenCalledOnce());
    const visible = container.querySelector("canvas")!;
    const detached = vi.mocked(QRCode.toCanvas).mock.calls[0]![0] as HTMLCanvasElement;
    expect(detached).not.toBe(visible);
    expect(visible.width).toBe(0);
    window.dispatchEvent(new Event("pagehide"));
    await act(async () => renderer.resolve());
    expect(drawImage).not.toHaveBeenCalled();
    expect(visible.width).toBe(0);
    expect(container.textContent).not.toContain(TOKEN_A);
  });

  it("ignores a stale renderer rejection without an unhandled error", async () => {
    const renderer = deferred<void>();
    vi.mocked(QRCode.toCanvas).mockImplementationOnce(() => renderer.promise as never);
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    try {
      const { container } = render(panel(vi.fn(async () => issuance()) as typeof fetch));
      fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
      await waitFor(() => expect(QRCode.toCanvas).toHaveBeenCalledOnce());
      window.dispatchEvent(new Event("pagehide"));
      await act(async () => { renderer.reject(new Error("late renderer")); await Promise.resolve(); });
      expect(unhandled).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain(TOKEN_A);
      expect(container.textContent).not.toMatch(/could not be drawn/i);
    } finally { window.removeEventListener("unhandledrejection", unhandled); }
  });

  it("gives overlong-expiry 2xx issuance zero credential or QR side effects", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const fetcher = vi.fn(async () => issuance(TOKEN_A, { expiresAtMs: 1_600_001 }));
      const { container } = render(panel(fetcher as typeof fetch));
      fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
      await screen.findByText(/invalid or unavailable/i);
      expect(container.textContent).not.toContain(TOKEN_A);
      expect(container.querySelector("canvas")?.width ?? 0).toBe(0);
      expect(QRCode.toCanvas).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it("clears token and canvas on real timer expiry", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => issuance(TOKEN_A, { expiresAtMs: Date.now() + 1_000 }));
      const { container } = render(panel(fetcher as typeof fetch));
      fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(container.textContent).not.toContain(TOKEN_A);
      expect(container.querySelector("canvas")?.width ?? 0).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not navigate Staff on malformed successful acknowledgement", async () => {
    const fetcher = vi.fn(async () => Response.json({ completion: "COLLECTED" }));
    const { container } = render(<StaffHandoffForm
      claimId="claim-ui" claimVersion={6} itemVersion={4} reportVersion={3}
      generation={1} csrfToken="csrf" fetcher={fetcher as typeof fetch}
    />);
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    fireEvent.change(input, { target: { value: TOKEN_A } });
    fireEvent.submit(screen.getByRole("form", { name: /staff pickup handoff/i }));
    await screen.findByText(/invalid handoff response/i);
    expect(input.value).toBe("");
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
