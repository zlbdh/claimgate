import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { performSameOriginWrite } from "@/server/http/same-origin-write";
import { CandidateCard } from "./candidate-card";
import { CandidateFinder } from "./candidate-finder";
import { PrivacyBoundary } from "./privacy-boundary";
import { ReportCreateForm } from "./report-create-form";
import { ReportIndex } from "./report-index";
import { ReportUpdateForm } from "./report-update-form";

const candidate = {
  candidateHandle: `cgch1.1787745600.1787746500.${"A".repeat(43)}`,
  category: "earbuds",
  timeBand: "within six hours",
  area: "library",
  color: "black",
  confidence: "strong" as const,
  reasons: ["The general area matches.", "Two public descriptors overlap."],
  expiresAt: 1_787_746_500,
};

describe("Claimant report workspace components", () => {
  it("renders a semantic candidate with textual confidence and no visible/internal identity", () => {
    const { container } = render(<CandidateCard candidate={candidate} />);
    expect(screen.getByRole("article", { name: /strong confidence candidate/i })).toBeVisible();
    expect(screen.getByText("Strong confidence")).toBeVisible();
    expect(screen.getByText("within six hours")).toBeVisible();
    expect(screen.getByRole("list")).toBeVisible();
    expect(container).not.toHaveTextContent(candidate.candidateHandle);
    expect(container.innerHTML).not.toMatch(/inventoryItemId|candidateId|foundAt|score|publicTags|publicDescription/);
  });

  it("states the privacy boundary without relying on color", () => {
    render(<PrivacyBoundary />);
    expect(screen.getByRole("note", { name: /privacy boundary/i })).toHaveTextContent(
      /ownership answers stay out of agent and search output/i,
    );
  });

  it("provides accessible empty and error report-index states", () => {
    const { rerender } = render(<ReportIndex reports={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no reports yet/i);
    rerender(<ReportIndex reports={[]} error="Reports could not be loaded." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Reports could not be loaded.");
  });

  it("spends match quota only after the deliberate Find candidates control", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      candidates: [candidate],
      message: "1 privacy-safe candidate found.",
    }));
    render(<CandidateFinder reportId="report-public" fetcher={fetcher} />);
    expect(fetcher).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Find candidates" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledWith("/api/reports/report-public/matches?limit=3", expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store",
    }));
    expect(await screen.findByText("Strong confidence")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("1 privacy-safe candidate found.");
  });

  it("labels the compact draft form and submits reusable CSRF with a cryptographic idempotency key", async () => {
    const writer = vi.fn<typeof performSameOriginWrite>(async () => (
      Response.json({ nextPath: "/claimant/reports/r1" }, { status: 201 })
    ));
    const navigate = vi.fn();
    render(<ReportCreateForm csrfToken="reusable-csrf" writer={writer} onNavigate={navigate} />);
    expect(screen.getByRole("form", { name: "Create lost report draft" })).toBeVisible();
    for (const label of ["Category", "From", "To", "Area", "Color", "Public descriptors", "Public description"]) {
      expect(screen.getByLabelText(label)).toBeVisible();
    }
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "earbuds" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-25T17:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-25T19:00" } });
    fireEvent.change(screen.getByLabelText("Area"), { target: { value: "library" } });
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: "black" } });
    fireEvent.change(screen.getByLabelText("Public descriptors"), { target: { value: "wireless, charging-case" } });
    fireEvent.change(screen.getByLabelText("Public description"), { target: { value: "Black earbud case." } });
    await userEvent.click(screen.getByRole("button", { name: "Save private draft" }));
    await waitFor(() => expect(writer).toHaveBeenCalledOnce());
    const call = writer.mock.calls[0]![0];
    expect(call.path).toBe("/api/reports");
    expect(call.csrfToken).toBe("reusable-csrf");
    const body = call.body as URLSearchParams;
    expect(body.get("idempotencyKey")).toMatch(/^[A-Fa-f0-9-]{36}$/);
    expect(body.get("publicTags")).toBe('["wireless","charging-case"]');
    expect(navigate).toHaveBeenCalledWith("/claimant/reports/r1");
  });

  it("submits an owner draft update to its concrete path with expected version", async () => {
    const writer = vi.fn<typeof performSameOriginWrite>(async () => (
      Response.json({ nextPath: "/claimant/reports/report-public" })
    ));
    render(<ReportUpdateForm
      csrfToken="update-csrf"
      report={{
        reportId: "report-public",
        category: "earbuds",
        timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
        area: "library",
        color: "black",
        publicTags: ["wireless"],
        publicDescription: "Black earbud case.",
        status: "DRAFT",
        version: 4,
      }}
      writer={writer}
      onNavigate={vi.fn()}
    />);
    expect(screen.getByRole("form", { name: "Update lost report draft" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writer).toHaveBeenCalledOnce());
    const input = writer.mock.calls[0]![0];
    expect(input.path).toBe("/api/reports/report-public");
    expect((input.body as URLSearchParams).get("expectedVersion")).toBe("4");
    expect((input.body as URLSearchParams).get("idempotencyKey")).toMatch(/^[A-Fa-f0-9-]{36}$/);
  });
});
