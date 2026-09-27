import type { Check, Outcome, Severity } from "./types.js";
export const docs = "https://developers.google.com/search/docs/";
export function check(
  rule: string,
  category: string,
  url: string,
  severity: Severity,
  valid: boolean | Outcome,
  message: string,
  evidence: unknown,
  remediation: string,
  documentation = docs + "fundamentals/seo-starter-guide",
): Check {
  return {
    rule,
    category,
    url,
    severity,
    outcome: typeof valid === "boolean" ? (valid ? "passed" : "failed") : valid,
    message,
    evidence,
    remediation,
    documentation,
  };
}
