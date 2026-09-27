import { validateOptions, glob } from "./config.js";
import { crawl } from "./crawl.js";
import { coreRules } from "./rules.js";
import { depthRules } from "./depth.js";
import { siteRules } from "./site-rules.js";
import { advancedRules } from "./advanced.js";
import { seoScore } from "./score.js";
import { schemaRules, vocabularyVersion, ruleVersion } from "./schema.js";
import { performance } from "./performance.js";
import { redact, headerSecrets } from "./report.js";
import type { Options, Report } from "./types.js";
export type * from "./types.js";
export { writeReport, htmlReport, exitCode } from "./report.js";
export { seoScore } from "./score.js";
export async function audit(
  input: Partial<Options>,
  progress?: (message: string) => void,
): Promise<Report> {
  const o = validateOptions(input);
  const startedAt = new Date().toISOString();
  const result = await crawl(o, progress);
  progress?.("Evaluating page, link and structured-data checks…");
  const checks = [
    ...result.checks,
    ...(await coreRules(result, o)),
    ...depthRules(result.pages, o),
    ...(await siteRules(result.pages, o)),
  ];
  for (const page of result.pages) {
    if (page.status < 200 || page.status >= 400 || page.error) continue;
    if (page.raw) checks.push(...(await schemaRules(page, page.raw, "raw")));
    if (
      page.rendered &&
      JSON.stringify(page.raw?.structured) !==
        JSON.stringify(page.rendered.structured)
    )
      checks.push(...(await schemaRules(page, page.rendered, "rendered")));
  }
  checks.push(...(await advancedRules(result, o, progress)));
  for (const c of checks) {
    c.confidence ??= c.outcome === "inconclusive" ? "unverified" : "observed";
    if (o.severityOverrides[c.rule]) c.severity = o.severityOverrides[c.rule];
    const suppression = o.suppressions.find(
      (s) =>
        s.rule === c.rule &&
        (glob(c.url, s.urlPattern) ||
          glob(new URL(c.url).pathname, s.urlPattern)),
    );
    if (suppression) c.suppression = suppression.reason;
  }
  const lighthouse = await performance(result.pages, o);
  if (lighthouse.some((r) => r.error))
    result.reasons.push("One or more requested Lighthouse audits failed");
  const { headers, ...settings } = o;
  const report: Report = {
    version: "1",
    toolVersion: "0.1.1",
    ruleVersion,
    vocabularyVersion,
    startedAt,
    completedAt: new Date().toISOString(),
    settings: { ...settings, headers: Object.keys(headers) },
    coverage: {
      complete: !result.reasons.length,
      reasons: result.reasons,
      discovered: result.discovered,
      scanned: result.pages.filter((p) => !p.blocked).length,
      blocked: result.pages.filter((p) => p.blocked).length,
      sitemapUrls: result.sitemapUrls,
    },
    pages: result.pages,
    checks: checks.sort(
      (a, b) => a.url.localeCompare(b.url) || a.rule.localeCompare(b.rule),
    ),
    lighthouse,
  };
  report.score = seoScore(report.checks, report.coverage.complete);
  // Keep schema check details and remove full HTML and scripts from reports.
  for (const p of report.pages) {
    for (const key of Object.keys(p.headers))
      if (
        /^(set-cookie|cookie|authorization|proxy-authorization|www-authenticate|proxy-authenticate)$/i.test(
          key,
        )
      )
        p.headers[key] = "[REDACTED]";
    for (const s of [p.raw, p.rendered])
      if (s)
        s.structured = s.structured.map((b) => ({
          ...b,
          value: `[${b.value.length} characters; see check details]`,
        }));
  }
  return redact(report, headerSecrets(headers));
}
