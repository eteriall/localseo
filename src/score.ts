import type { Check, SEOScore } from "./types.js";

/** Equal category weights; rule means prevent repeated entities from dominating. */
export function seoScore(checks: Check[], complete: boolean): SEOScore {
  const eligible = (c: Check) =>
    c.severity !== "info" &&
    !c.suppression &&
    !/^(social\.|schema\.visible|content\.near)/.test(c.rule) &&
    !["Social", "Sharing"].includes(c.category) &&
    c.confidence !== "heuristic";
  const measured = checks.filter(
    (c) =>
      eligible(c) &&
      c.confidence !== "unverified" &&
      ["passed", "failed"].includes(c.outcome),
  );
  const groups = new Map<
    string,
    Map<string, Map<string, { pass: boolean; weight: number }>>
  >();
  for (const c of measured) {
    if (!groups.has(c.category)) groups.set(c.category, new Map());
    const rules = groups.get(c.category)!;
    if (!rules.has(c.rule)) rules.set(c.rule, new Map());
    const pages = rules.get(c.rule)!;
    const old = pages.get(c.url);
    pages.set(c.url, {
      pass: c.outcome === "passed" && (old?.pass ?? true),
      weight: Math.max(old?.weight ?? 0, c.severity === "error" ? 3 : 1),
    });
  }
  const categories = [...groups]
    .map(([name, rules]) => {
      let earned = 0,
        total = 0,
        evaluated = 0;
      for (const pages of rules.values()) {
        const values = [...pages.values()];
        const weight = Math.max(...values.map((v) => v.weight));
        earned +=
          (weight * values.filter((v) => v.pass).length) / values.length;
        total += weight;
        evaluated += values.length;
      }
      return { name, value: Math.round((100 * earned) / total), evaluated };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const value = categories.length
    ? Math.round(
        categories.reduce((sum, c) => sum + c.value, 0) / categories.length,
      )
    : null;
  return {
    value,
    band:
      value === null
        ? "unavailable"
        : value >= 90
          ? "good"
          : value >= 50
            ? "needs-work"
            : "poor",
    provisional:
      !complete ||
      checks.some(
        (c) => eligible(c) && ["inconclusive", "skipped"].includes(c.outcome),
      ),
    evaluated: categories.reduce((sum, c) => sum + c.evaluated, 0),
    excluded: checks.length - measured.length,
    categories,
    methodology:
      "Technical SEO only. Deduplicate by category/rule/URL (any failure wins); average page pass rates per rule, weight errors 3 and warnings 1, then equally average categories. Exclude info, heuristics, suppressed, sharing and unverified checks. 90–100 good, 50–89 needs work, 0–49 poor. Not a ranking prediction; scores require the same scope and rule version for comparison.",
  };
}
