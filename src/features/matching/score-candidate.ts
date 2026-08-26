import type { FoundItem, PublicFoundItem } from "@/features/inventory/found-item";

export type TimeWindow = { from: string; to: string };
export type LostReport = {
  category: string;
  timeWindow: TimeWindow;
  area: string;
  color: string;
  publicTags: string[];
  publicDescription: string;
};
export type MatchCandidate = {
  candidateId: string;
  score: number;
  confidence: "strong" | "possible" | "weak";
  reasons: string[];
  publicSummary: PublicFoundItem;
};

export function confidenceForScore(score: number): MatchCandidate["confidence"] {
  return score >= 75 ? "strong" : score >= 60 ? "possible" : "weak";
}

export const ADJACENT_AREAS: Record<string, readonly string[]> = {
  library: ["student-center", "park", "station"],
  "student-center": ["library", "park"],
  park: ["library", "student-center"],
  station: ["library"],
};

const COLOR_FAMILIES: Record<string, string> = {
  red: "warm", orange: "warm", yellow: "warm", pink: "warm", brown: "warm",
  blue: "cool", green: "cool", purple: "cool", teal: "cool", navy: "cool",
  black: "neutral", white: "neutral", gray: "neutral", grey: "neutral", silver: "neutral",
};

const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/[-‐‑‒–—―]/g, "-").replace(/\s+/g, " ");
const hours = 60 * 60 * 1000;

function timeScore(report: LostReport, foundAt: string): number {
  const start = Date.parse(report.timeWindow.from);
  const end = Date.parse(report.timeWindow.to);
  const found = Date.parse(foundAt);
  if ([start, end, found].some(Number.isNaN)) return 0;
  const distance = found < start ? start - found : found > end ? found - end : 0;
  if (distance <= 6 * hours) return 30;
  const reportDay = new Date(start).toISOString().slice(0, 10);
  if (new Date(found).toISOString().slice(0, 10) === reportDay) return 20;
  if (distance <= 24 * hours) return 10;
  return 0;
}

export function scoreCandidate(report: LostReport, item: FoundItem): MatchCandidate | null {
  if (normalize(report.category) !== normalize(item.category)) return null;
  const reasons: string[] = [];
  let score = 0;
  const temporal = timeScore(report, item.foundAt);
  if (temporal) { score += temporal; reasons.push(`time match (+${temporal})`); }
  const area = normalize(report.area);
  const foundArea = normalize(item.area);
  if (area === foundArea) { score += 25; reasons.push("same area (+25)"); }
  else if (ADJACENT_AREAS[area]?.includes(foundArea)) { score += 12; reasons.push("adjacent area (+12)"); }
  const color = normalize(report.color);
  const foundColor = normalize(item.color);
  if (color === foundColor) { score += 20; reasons.push("same color (+20)"); }
  else if (COLOR_FAMILIES[color] && COLOR_FAMILIES[color] === COLOR_FAMILIES[foundColor]) { score += 10; reasons.push("same color family (+10)"); }
  const foundTags = new Set(item.publicTags.map(normalize));
  const sharedTags = report.publicTags.map(normalize).filter((tag, index, tags) => tags.indexOf(tag) === index && foundTags.has(tag));
  const tagScore = Math.min(sharedTags.length * 5, 25);
  if (tagScore) { score += tagScore; reasons.push(`${sharedTags.length} shared public tag(s) (+${tagScore})`); }
  const confidence = confidenceForScore(score);
  return { candidateId: item.candidateId, score, confidence, reasons, publicSummary: { category: item.category, foundAt: item.foundAt, area: item.area, color: item.color, publicTags: [...item.publicTags], publicDescription: item.publicDescription } };
}
