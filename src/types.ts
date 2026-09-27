export type Severity = "error" | "warning" | "info";
export type Outcome = "passed" | "failed" | "skipped" | "inconclusive";
export interface Check {
  rule: string;
  category: string;
  url: string;
  severity: Severity;
  outcome: Outcome;
  message: string;
  evidence: unknown;
  remediation: string;
  documentation: string;
  source?: string;
  suppression?: string;
  confidence?: "observed" | "heuristic" | "unverified";
}
export interface Options {
  url: string;
  productionOrigin?: string;
  render: "both" | "off";
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  browserConcurrency: number;
  timeout: number;
  settle: number;
  waitSelector?: string;
  includeQuery: boolean;
  ignoreRobots: boolean;
  probe404: boolean;
  advanced: boolean;
  advancedPages: number;
  assetLimit: number;
  projectDir?: string;
  insecure: boolean;
  urls: string[];
  exclude: string[];
  headers: Record<string, string>;
  output: string;
  failOn: Severity | "none";
  lighthouse: boolean;
  lighthousePages: number;
  lighthouseUrls: string[];
  severityOverrides: Record<string, Severity>;
  suppressions: { rule: string; urlPattern: string; reason: string }[];
}
export interface StructuredBlock {
  format: "jsonld" | "microdata" | "rdfa";
  source: string;
  value: string;
}
export interface Snapshot {
  titles: string[];
  descriptions: string[];
  canonicals: string[];
  robots: string[];
  headings: { level: number; text: string }[];
  links: string[];
  images: { src: string; alt?: string }[];
  hreflang: { lang: string; href: string }[];
  lang: string;
  viewport: string;
  charset: boolean;
  refresh: string[];
  social: Record<string, string>;
  text: string;
  mainText?: string;
  anchorIssues?: { html: string; reason: string }[];
  structured: StructuredBlock[];
  technical?: {
    bytes: number;
    headIssues: string[];
    resources: { url: string; type: string }[];
    srcsets?: {
      source: string;
      candidates: { url: string; descriptor: string }[];
      issues: string[];
    }[];
    schemaMedia?: { url: string; type: string }[];
    responsiveImages: {
      src: string;
      srcset: string;
      sizes: string;
      width?: string;
      height?: string;
      picture: boolean;
    }[];
    videos: { src: string; poster: string; loading: string }[];
    pagination: { rel: string; url: string }[];
    snippetElements: { tag: string; value: string }[];
    contentAfterLimit: boolean;
  };
}
export interface Page {
  url: string;
  publicUrl: string;
  depth: number;
  discoveredBy: string[];
  status: number;
  finalUrl: string;
  redirects: string[];
  headers: Record<string, string>;
  raw?: Snapshot;
  rendered?: Snapshot;
  error?: string;
  renderError?: string;
  blocked?: boolean;
  robotsDisallowed?: boolean;
  resourceFailures?: {
    url: string;
    type: string;
    status?: number;
    error?: string;
  }[];
  renderSettled?: boolean;
  consoleErrors: string[];
  socialPreviews?: {
    url: string;
    width: number;
    height: number;
    thumbnail: string;
  }[];
}
export interface Report {
  score?: SEOScore;
  version: "1";
  toolVersion: string;
  ruleVersion: string;
  vocabularyVersion: string;
  startedAt: string;
  completedAt: string;
  settings: Omit<Options, "headers"> & { headers: string[] };
  coverage: {
    complete: boolean;
    reasons: string[];
    discovered: number;
    scanned: number;
    blocked: number;
    sitemapUrls: string[];
  };
  pages: Page[];
  checks: Check[];
  lighthouse: {
    url: string;
    scores?: Record<string, number | null>;
    metrics?: Record<string, unknown>;
    error?: string;
  }[];
  comparison?: {
    baseline: string;
    added: string[];
    resolved: string[];
    persisting: string[];
    comparable: boolean;
    note: string;
  };
}
export interface SEOScore {
  value: number | null;
  band: "good" | "needs-work" | "poor" | "unavailable";
  provisional: boolean;
  evaluated: number;
  excluded: number;
  categories: { name: string; value: number; evaluated: number }[];
  methodology: string;
}
