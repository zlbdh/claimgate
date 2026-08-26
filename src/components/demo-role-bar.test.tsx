import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoRoleBar } from "./demo-role-bar";

describe("最小 demo role bar", () => {
  it("用文本展示角色、到期时间和非生产边界，并提供键盘可提交表单", () => {
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
  });
});
