import type { LostReportRecord } from "@/server/db/repository";

export type PublicReportDto = Readonly<{
  reportId: string;
  category: string;
  timeWindow: Readonly<{ from: string; to: string }>;
  area: string;
  color: string;
  publicTags: readonly string[];
  publicDescription: string;
  status: LostReportRecord["status"];
  version: number;
}>;

export type ReportAckDto = Readonly<{
  reportId: string;
  status: "DRAFT";
  version: number;
  nextPath: string;
}>;

export type BrowserCandidateDto = Readonly<{
  candidateHandle: string;
  category: string;
  timeBand: string;
  area: string;
  color: string;
  confidence: "strong" | "possible" | "weak";
  reasons: readonly string[];
  expiresAt: number;
}>;

export type CandidateListDto = Readonly<{
  candidates: readonly BrowserCandidateDto[];
  message: string;
}>;

export type CandidateSearchDto = CandidateListDto & Readonly<{
  reportVersion: number;
}>;
