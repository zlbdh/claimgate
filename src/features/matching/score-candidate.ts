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
export type ServerMatchCandidate = {
  inventoryItemId: string;
  score: number;
  confidence: "strong" | "possible" | "weak";
  reasons: string[];
  timeBand: "within six hours" | "same calendar day" | "within 24 hours" | "outside 24 hours";
  item: PublicFoundItem;
};

export function confidenceForScore(score: number): ServerMatchCandidate["confidence"] {
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

function timeScore(report: LostReport, foundAt: string): {
  points: number;
  band: ServerMatchCandidate["timeBand"];
} {
  const start = Date.parse(report.timeWindow.from);
  const end = Date.parse(report.timeWindow.to);
  const found = Date.parse(foundAt);
  if ([start, end, found].some(Number.isNaN)) return { points: 0, band: "outside 24 hours" };
  const distance = found < start ? start - found : found > end ? found - end : 0;
  if (distance <= 6 * hours) return { points: 30, band: "within six hours" };
  const reportDay = new Date(start).toISOString().slice(0, 10);
  if (new Date(found).toISOString().slice(0, 10) === reportDay) {
    return { points: 20, band: "same calendar day" };
  }
  if (distance <= 24 * hours) return { points: 10, band: "within 24 hours" };
  return { points: 0, band: "outside 24 hours" };
}

export function scoreCandidate(report: LostReport, item: FoundItem): ServerMatchCandidate | null {
  if (normalize(report.category) !== normalize(item.category)) return null;
  const reasons: string[] = [];
  let score = 0;
  const temporal = timeScore(report, item.foundAt);
  if (temporal.points) {
    score += temporal.points;
    reasons.push(`Found ${temporal.band} of the reported window.`);
  }
  const area = normalize(report.area);
  const foundArea = normalize(item.area);
  if (area === foundArea) { score += 25; reasons.push("The general area matches."); }
  else if (ADJACENT_AREAS[area]?.includes(foundArea)) { score += 12; reasons.push("The item was logged in a nearby area."); }
  const color = normalize(report.color);
  const foundColor = normalize(item.color);
  if (color === foundColor) { score += 20; reasons.push("The reported color matches."); }
  else if (COLOR_FAMILIES[color] && COLOR_FAMILIES[color] === COLOR_FAMILIES[foundColor]) { score += 10; reasons.push("The colors are in the same broad family."); }
  const foundTags = new Set(item.publicTags.map(normalize));
  const sharedTags = report.publicTags.map(normalize).filter((tag, index, tags) => tags.indexOf(tag) === index && foundTags.has(tag));
  const tagScore = Math.min(sharedTags.length * 5, 25);
  if (tagScore) { score += tagScore; reasons.push(`${sharedTags.length} public descriptors overlap.`); }
  const confidence = confidenceForScore(score);
  return {
    inventoryItemId: item.inventoryItemId,
    score,
    confidence,
    reasons,
    timeBand: temporal.band,
    item: {
      category: item.category,
      foundAt: item.foundAt,
      area: item.area,
      color: item.color,
      publicTags: [...item.publicTags],
      publicDescription: item.publicDescription,
    },
  };
}
