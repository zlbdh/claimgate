import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createActivityStore } from "@/features/webmcp/activity-store";
import { AgentActivity } from "./agent-activity";

describe("AgentActivity visible bounded timeline", () => {
  it("shows both start and end times for each of the latest twenty entries", () => {
    let now = Date.UTC(2026, 7, 27, 10);
    const store = createActivityStore({ now: () => now++ });
    for (let index = 0; index < 21; index += 1) {
      const finish = store.begin("get_claim_status");
      finish({ success: true, stateChange: "Claim status read" });
    }
    render(<AgentActivity store={store} status="registered" />);
    const list = screen.getByRole("list", { name: /recent agent tool activity/i });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(within(list).getAllByLabelText(/^Started /)).toHaveLength(20);
    expect(within(list).getAllByLabelText(/^Ended /)).toHaveLength(20);
  });
});
