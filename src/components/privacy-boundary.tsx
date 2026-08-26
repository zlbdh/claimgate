import { LockKeyhole } from "lucide-react";

export interface PrivacyBoundaryProps {
  className?: string;
}

export function PrivacyBoundary({ className = "" }: PrivacyBoundaryProps) {
  return (
    <aside
      className={`privacy-boundary ${className}`.trim()}
      role="note"
      aria-label="Privacy boundary"
    >
      <LockKeyhole aria-hidden="true" size={20} strokeWidth={1.6} />
      <div>
        <strong>Ownership answers remain private.</strong>
        <p>Ownership answers stay out of Agent and search output. Matching uses public descriptors only; people verify before release.</p>
      </div>
    </aside>
  );
}
