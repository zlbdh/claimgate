import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoRoleBar } from "./demo-role-bar";

describe("Minimal demo role bar", () => {
  it("shows role, expiration, and demo limitations as text and omits resume context on home", () => {
    const expiresAt = Date.UTC(2026, 7, 26, 14);
    render(<DemoRoleBar
      role="CLAIMANT"
      expiresAt={expiresAt}
      csrfToken="hidden-csrf"
    />);

    expect(screen.getByText("Current role: Claimant")).toBeVisible();
    expect(screen.getByText(/Expires:/)).toHaveTextContent(new Date(expiresAt).toISOString());
    expect(screen.getByText("Public demo role switch — not production access control."))
      .toBeVisible();
    const button = screen.getByRole("button", { name: "Switch to Staff role" });
    expect(button).toHaveAttribute("type", "submit");
    const form = button.closest("form");
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/demo/switch-role");
    expect(form?.querySelector('input[name="csrfToken"]')).toHaveValue("hidden-csrf");
    expect(form?.querySelector('input[name="targetRole"]')).toHaveValue("STAFF");
    expect(form?.querySelectorAll('input[name="resumeClaimId"]')).toHaveLength(0);
  });

  it("submits exactly one opaque resumeClaimId on the claim page", () => {
    render(<DemoRoleBar
      role="STAFF"
      expiresAt={Date.UTC(2026, 7, 26, 14)}
      csrfToken="hidden-csrf"
      resumeClaimId="claim-public-123"
    />);

    const form = screen.getByRole("button", { name: "Switch to Claimant role" }).closest("form");
    const resumeInputs = form?.querySelectorAll('input[name="resumeClaimId"]');
    expect(resumeInputs).toHaveLength(1);
    expect(resumeInputs?.item(0)).toHaveValue("claim-public-123");
  });
});
