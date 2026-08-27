import { existsSync, readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvidenceForm } from "./evidence-form";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

describe("claim review UI privacy contracts", () => {
  it("clears password fields before awaiting transport and never stores raw answers", () => {
    const path = "src/components/evidence-form.tsx";
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).toContain('type="password"');
    expect(source).toContain('autoComplete="off"');
    expect(source).toContain("spellCheck={false}");
    expect(source).toContain("input.value = \"\"");
    expect(source.indexOf("input.value = \"\"")).toBeLessThan(source.indexOf("await fetcher"));
    expect(source).toContain("useRef");
    expect(source).toContain("pageshow");
    expect(source).toContain("finally");
    expect(source).not.toMatch(/localStorage|sessionStorage|history\.|console\./);
    expect(source).not.toMatch(/useState\([^)]*(answer|evidence)/i);
    expect(source).not.toContain("URLSearchParams(window");
  });

  it("empties all three DOM password values before the fetch promise settles", () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const { container } = render(<EvidenceForm
      claimId="claim-test"
      csrfToken="csrf-test"
      expectedVersion={1}
      fetcher={fetcher as typeof fetch}
    />);
    const fields = [...container.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(fields).toHaveLength(3);
    fields.forEach((field, index) => fireEvent.change(field, { target: { value: `canary-${index}` } }));
    fireEvent.submit(screen.getByRole("form", { name: /private evidence/i }));
    expect(fetcher).toHaveBeenCalledOnce();
    fields.forEach((field) => expect(field.value).toBe(""));
  });

  it("clears browser-restored password values on pageshow including persisted BFCache", () => {
    const fetcher = vi.fn();
    const { container } = render(<EvidenceForm
      claimId="claim-test"
      csrfToken="csrf-test"
      expectedVersion={1}
      fetcher={fetcher as typeof fetch}
    />);
    const fields = [...container.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    fields.forEach((field, index) => { field.value = `restored-${index}`; });
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
    fields.forEach((field) => expect(field.value).toBe(""));
  });

  it("renders textual step states and three separate Staff actions", () => {
    const stepperPath = "src/components/claim-stepper.tsx";
    const decisionPath = "src/components/staff-decision-form.tsx";
    expect(existsSync(stepperPath)).toBe(true);
    expect(existsSync(decisionPath)).toBe(true);
    const stepper = readFileSync(stepperPath, "utf8");
    const decision = readFileSync(decisionPath, "utf8");
    expect(stepper).toContain("Current:");
    expect(stepper).toContain('aria-current="step"');
    expect(decision).toContain("Approve claim");
    expect(decision).toContain("Reject claim");
    expect(decision).toContain("Unlock claim");
    expect(decision).toContain(
      "This holds the item and rejects every competing claim; their reports remain open.",
    );
  });
});
