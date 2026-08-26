import type { BrowserCandidateDto } from "@/features/reports/report-types";

export interface CandidateCardProps {
  candidate: BrowserCandidateDto;
  className?: string;
}

const confidenceLabel = {
  strong: "Strong confidence",
  possible: "Possible match",
  weak: "Weak match",
} as const;

export function CandidateCard({ candidate, className = "" }: CandidateCardProps) {
  const label = confidenceLabel[candidate.confidence];
  return (
    <article className={`candidate-card ${className}`.trim()} aria-label={`${label} candidate`} tabIndex={0}>
      <header className="candidate-card-header">
        <span className={`confidence-stamp confidence-${candidate.confidence}`}>{label}</span>
        <span className="candidate-category">{candidate.category}</span>
      </header>
      <dl className="candidate-facts">
        <div><dt>Time band</dt><dd>{candidate.timeBand}</dd></div>
        <div><dt>Area</dt><dd>{candidate.area}</dd></div>
        <div><dt>Color</dt><dd>{candidate.color}</dd></div>
      </dl>
      <h3>Why it surfaced</h3>
      <ul className="candidate-reasons">
        {candidate.reasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
    </article>
  );
}
