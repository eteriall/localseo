import type { Report } from "./types.js";

/** Compare failed checks by rule, public URL and source, ignoring preview ports. */
export function compareReports(
  current: Report,
  baseline: Report,
): NonNullable<Report["comparison"]> {
  const keys = (r: Report) =>
    new Set(
      r.checks
        .filter((c) => c.outcome === "failed" && !c.suppression)
        .map((c) => {
          let url = c.url;
          try {
            const u = new URL(url);
            if (u.origin === new URL(r.settings.url).origin)
              url =
                (r.settings.productionOrigin ?? "[preview]") +
                u.pathname +
                u.search;
          } catch {}
          return [c.rule, url, c.source ?? ""].join(" | ");
        }),
    );
  const now = keys(current),
    before = keys(baseline);
  const fields = [
    "render",
    "maxPages",
    "maxDepth",
    "includeQuery",
    "ignoreRobots",
    "urls",
    "exclude",
    "productionOrigin",
    "suppressions",
    "advanced",
    "advancedPages",
    "assetLimit",
    "projectDir",
    "probe404",
    "severityOverrides",
  ] as const;
  const comparable =
    current.ruleVersion === baseline.ruleVersion &&
    current.coverage.complete &&
    baseline.coverage.complete &&
    fields.every(
      (f) =>
        JSON.stringify(current.settings[f]) ===
        JSON.stringify(baseline.settings[f]),
    );
  return {
    baseline: baseline.completedAt,
    added: [...now].filter((k) => !before.has(k)).sort(),
    resolved: [...before].filter((k) => !now.has(k)).sort(),
    persisting: [...now].filter((k) => before.has(k)).sort(),
    comparable,
    note: comparable
      ? "Observed finding changes; absence is not proof of a fix outside the audited scope."
      : "Different rules, scope or incomplete coverage: disappeared findings are not verified fixes.",
  };
}
