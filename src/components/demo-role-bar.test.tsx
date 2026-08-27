import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoRoleBar } from "./demo-role-bar";

describe("最小 demo role bar", () => {
  it("用文本展示角色、到期时间和非生产边界，并在 home 省略 resume context", () => {
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

  it("在 claim page 恰好提交一个 opaque resumeClaimId", () => {
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
