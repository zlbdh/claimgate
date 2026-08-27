import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { PickupPassPanel } from "./pickup-pass-panel";
import { StaffHandoffForm } from "./staff-handoff-form";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn(() => Promise.resolve()) } }));

const TOKEN = "abcdefghijklmnopqrstuA";

describe("pickup pass client-only credential lifecycle", () => {
  it("draws to canvas, keeps the default DOM masked and reveals only on explicit action", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(), drawImage,
    } as never);
    const fetcher = vi.fn(async () => Response.json({
      issuance: "ISSUED", claimId: "claim-ui", status: "PICKUP_READY",
      claimVersion: 6, generation: 1, expiresAtMs: Date.now() + 600_000, token: TOKEN,
    }));
    const { container } = render(<PickupPassPanel
      claimId="claim-ui" status="APPROVED" claimVersion={5}
      issueCsrfToken="csrf-issue" fetcher={fetcher as typeof fetch}
    />);
    fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
    await waitFor(() => expect(QRCode.toCanvas).toHaveBeenCalled());
    const visible = container.querySelector("canvas")!;
    const detached = vi.mocked(QRCode.toCanvas).mock.calls[0]![0] as HTMLCanvasElement;
    expect(detached).not.toBe(visible);
    await waitFor(() => expect(drawImage).toHaveBeenCalledWith(detached, 0, 0));
    expect(container.textContent).not.toContain(TOKEN);
    expect(screen.getByText(/••••/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reveal credential/i }));
    expect(screen.getByText(TOKEN)).toBeInTheDocument();
  });

  it("clears token, canvas dimensions and pixels on pagehide/pageshow/popstate and unmount", async () => {
    const clearRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect } as never);
    const fetcher = vi.fn(async () => Response.json({
      issuance: "ISSUED", claimId: "claim-ui", status: "PICKUP_READY",
      claimVersion: 6, generation: 1, expiresAtMs: Date.now() + 600_000, token: TOKEN,
    }));
    const { container, unmount } = render(<PickupPassPanel
      claimId="claim-ui" status="APPROVED" claimVersion={5}
      issueCsrfToken="csrf-issue" fetcher={fetcher as typeof fetch}
    />);
    fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
    await waitFor(() => expect(QRCode.toCanvas).toHaveBeenCalled());
    const canvas = container.querySelector("canvas")!;
    canvas.width = 224;
    canvas.height = 224;
    window.dispatchEvent(new Event("pagehide"));
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(container.textContent).not.toContain(TOKEN);
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("popstate"));
    unmount();
    expect(clearRect).toHaveBeenCalled();
  });

  it("explains ALREADY_ISSUED without a token and keeps reissue a separate explicit control", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect: vi.fn() } as never);
    const fetcher = vi.fn(async () => Response.json({
      issuance: "ALREADY_ISSUED", claimId: "claim-ui", status: "PICKUP_READY",
      claimVersion: 6, generation: 1, expiresAtMs: Date.now() + 600_000,
    }));
    render(<PickupPassPanel
      claimId="claim-ui" status="APPROVED" claimVersion={5}
      issueCsrfToken="csrf-issue" fetcher={fetcher as typeof fetch}
    />);
    fireEvent.click(screen.getByRole("button", { name: /generate pickup pass/i }));
    expect(await screen.findByText(/original credential cannot be recovered/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reissue/i })).not.toBeInTheDocument();

    render(<PickupPassPanel
      claimId="claim-ui" status="PICKUP_READY" claimVersion={6}
      generation={1} expiresAtMs={Date.now() + 600_000} reissueCsrfToken="csrf-reissue"
      fetcher={fetcher as typeof fetch}
    />);
    expect(screen.getByRole("button", { name: /reissue pickup pass/i })).toBeInTheDocument();
  });

  it("clears the Staff password before transport, finally and BFCache restore", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const { container } = render(<StaffHandoffForm
      claimId="claim-ui" claimVersion={6} itemVersion={4} reportVersion={3}
      generation={1} csrfToken="csrf-handoff" fetcher={fetcher as typeof fetch}
    />);
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.autocomplete).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    fireEvent.change(input, { target: { value: TOKEN } });
    fireEvent.submit(screen.getByRole("form", { name: /staff pickup handoff/i }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(input.value).toBe("");
    resolveFetch(Response.json({
      kind: "handoff_ack", claimId: "claim-ui", completion: "COLLECTED",
      claimStatus: "COLLECTED", claimVersion: 7,
      itemStatus: "RETURNED", itemVersion: 5,
      reportStatus: "RESOLVED", reportVersion: 4, generation: 1,
    }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    input.value = TOKEN;
    window.dispatchEvent(new Event("pageshow"));
    expect(input.value).toBe("");
  });
});
