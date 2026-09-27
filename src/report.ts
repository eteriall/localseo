import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Report } from "./types.js";
import { htmlReport } from "./report-ui.js";
export function headerSecrets(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .flatMap(([key, value]) => [
      value,
      ...(/authorization/i.test(key) ? [value.replace(/^\S+\s+/, "")] : []),
      ...(/cookie/i.test(key)
        ? value.split(";").map((v) => v.slice(v.indexOf("=") + 1).trim())
        : []),
    ])
    .filter(Boolean);
}
export function redact<T>(value: T, secrets: string[]): T {
  const walk = (v: any): any => {
    if (typeof v === "string") {
      for (const secret of secrets
        .filter(Boolean)
        .sort((a, b) => b.length - a.length))
        v = v.split(secret).join("[REDACTED]");
      return v.replace(
        /([?&](?:token|access_token|api_key|key|password|secret|authorization|session)=)[^&#\s"<>]+/gi,
        "$1[REDACTED]",
      );
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, walk(x)]),
      );
    return v;
  };
  return walk(value);
}
export const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export { htmlReport } from "./report-ui.js";
export async function writeReport(report: Report): Promise<string> {
  const dir = resolve(report.settings.output);
  await mkdir(dir, { recursive: true });
  for (const [name, contents] of [
    ["report.json", JSON.stringify(report, null, 2)],
    ["report.html", htmlReport(report)],
    ["issues.csv", issuesCsv(report)],
    ["summary.md", summaryMarkdown(report)],
  ]) {
    const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
    await writeFile(temp, contents);
    await rename(temp, join(dir, name));
  }
  return dir;
}
export function issuesCsv(report: Report): string {
  const cell = (v: unknown) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@-]/, "'$&")
      .replace(/"/g, '""') +
    '"';
  return [
    [
      "Rule",
      "Severity",
      "Outcome",
      "Confidence",
      "URL",
      "Message",
      "Remediation",
    ],
    ...report.checks
      .filter((c) => c.outcome === "failed" && !c.suppression)
      .map((c) => [
        c.rule,
        c.severity,
        c.outcome,
        c.confidence,
        c.url,
        c.message,
        c.remediation,
      ]),
  ]
    .map((row) => row.map(cell).join(","))
    .join("\r\n");
}
export function summaryMarkdown(report: Report): string {
  const issues = report.checks.filter(
    (c) => c.outcome === "failed" && !c.suppression,
  );
  const rules = [...new Set(issues.map((c) => c.rule))];
  return (
    `# localseo audit\n\n${report.settings.url}\n\nCoverage: ${report.coverage.complete ? "complete within configured scope" : "partial: " + report.coverage.reasons.join("; ")}\n\n${report.coverage.scanned} pages scanned. ${issues.length} findings across ${rules.length} rules.\n\n` +
    (report.score
      ? `SEO Score: ${report.score.value ?? "unavailable"}/100${report.score.provisional ? " (provisional)" : ""}. Technical audit, not a ranking prediction.\n\n`
      : "") +
    rules
      .map((rule) => {
        const list = issues.filter((c) => c.rule === rule);
        return (
          `## ${rule} (${list[0].severity})\n\n${list[0].remediation}\n\n` +
          [...new Set(list.map((c) => c.url))].map((u) => `- ${u}`).join("\n")
        );
      })
      .join("\n\n") +
    "\n"
  );
}
export function exitCode(report: Report): number {
  if (!report.coverage.complete) return 2;
  const rank = { error: 3, warning: 2, info: 1, none: 4 };
  return report.checks.some(
    (c) =>
      c.outcome === "failed" &&
      !c.suppression &&
      rank[c.severity] >= rank[report.settings.failOn],
  )
    ? 1
    : 0;
}
