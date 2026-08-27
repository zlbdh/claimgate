import type { ClaimStatus } from "@/features/claims/claim-state";

const STEPS = ["Report", "Match", "Prove", "Review", "Pickup"] as const;

function currentStep(status: ClaimStatus): number {
  if (status === "EVIDENCE_REQUIRED" || status === "LOCKED") return 2;
  if (status === "UNDER_REVIEW" || status === "REJECTED") return 3;
  return 4;
}

export function ClaimStepper({ status }: { status: ClaimStatus }) {
  const current = currentStep(status);
  return (
    <nav className="claim-steps" aria-label="Claim progress">
      {STEPS.map((step, index) => index === current
        ? <strong aria-current="step" key={step}>{step}<span className="sr-only"> · Current: {step}</span></strong>
        : index < current
          ? <strong key={step}>{step}<span className="sr-only"> · Complete</span></strong>
          : <span key={step}>{step}<span className="sr-only"> · Not reached</span></span>)}
    </nav>
  );
}
