import { check } from "./check.js";
import { noindex } from "./rules.js";
import { localUrl, normalize } from "./url.js";
import type { Check, Options, Page } from "./types.js";

/** Observed facts and explicitly labelled heuristics; no ranking-score guesses. */
export function depthRules(pages: Page[], o: Options): Check[] {
  const result: Check[] = [];
  const eligible = pages.filter(
    (p) =>
      p.status === 200 &&
      !p.error &&
      !p.blocked &&
      !noindex(p) &&
      !p.redirects.length,
  );
  const content = new Map<string, string[]>();
  for (const p of eligible) {
    const s = p.rendered ?? p.raw;
    if (!s) continue;
    const text = s.mainText
      ?.normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (text && text.length >= 200)
      content.set(text, [...(content.get(text) ?? []), p.url]);
    const add = (
      id: string,
      category: string,
      valid: boolean | "inconclusive" | "skipped",
      message: string,
      evidence: unknown,
      fix: string,
      heuristic = false,
    ) => {
      const c = check(
        id,
        category,
        p.url,
        heuristic ? "info" : "warning",
        valid,
        message,
        evidence,
        fix,
      );
      c.confidence =
        valid === "inconclusive"
          ? "unverified"
          : heuristic
            ? "heuristic"
            : "observed";
      result.push(c);
    };
    add(
      "links.labels",
      "Links",
      !s.anchorIssues?.length,
      "Anchor markup needs review",
      s.anchorIssues ?? [],
      "Use real href destinations and meaningful text or accessible image labels. Intentional action controls should be buttons.",
      true,
    );
    const failures = p.resourceFailures ?? [];
    add(
      "render.stability",
      "Rendering",
      !p.rendered
        ? "skipped"
        : p.renderSettled === false
          ? "inconclusive"
          : true,
      "Rendered DOM stability",
      { settled: p.renderSettled, quietWindowMs: o.settle },
      "Set an explicit wait selector for delayed content. Continuous DOM updates make extraction timing uncertain.",
    );
    add(
      "render.resources",
      "Rendering",
      !p.rendered ? "skipped" : !failures.length,
      "Failed browser resources",
      failures,
      "Inspect failed scripts, styles, images and API requests. Local backend failures can differ from production.",
    );
    if (o.productionOrigin) {
      const values = [
        ...s.canonicals,
        ...s.hreflang.map((h) => h.href),
        ...Object.entries(s.social)
          .filter(([k]) => /(?:url|image)$/.test(k))
          .map(([, v]) => v),
      ];
      const local = values.filter((v) => {
        try {
          const u = new URL(v);
          return (
            u.origin === new URL(o.url).origin ||
            /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
          );
        } catch {
          return false;
        }
      });
      add(
        "metadata.local-urls",
        "Metadata",
        !local.length,
        "Local URLs in public metadata",
        local,
        "Generate metadata with the configured production origin, not the preview server origin.",
      );
    }
    if (s.hreflang.length) {
      add(
        "hreflang.self",
        "Internationalization",
        s.hreflang.some((h) => localUrl(h.href, o) === p.url),
        "hreflang self-reference",
        s.hreflang,
        "Include this page alongside its alternate versions.",
      );
      const conflicts = [
        ...new Set(s.hreflang.map((h) => h.lang.toLowerCase())),
      ].filter(
        (lang) =>
          new Set(
            s.hreflang
              .filter((h) => h.lang.toLowerCase() === lang)
              .map((h) => h.href),
          ).size > 1,
      );
      add(
        "hreflang.conflicts",
        "Internationalization",
        !conflicts.length,
        "Conflicting hreflang destinations",
        conflicts,
        "Declare one destination per language tag.",
      );
    }
    const canonical = s.canonicals[0];
    if (canonical && s.social["og:url"])
      add(
        "social.canonical",
        "Sharing",
        normalize(canonical) === normalize(s.social["og:url"]),
        "Open Graph URL differs from canonical",
        { canonical, ogUrl: s.social["og:url"] },
        "Use the same preferred page URL for canonical and sharing metadata.",
      );
  }
  for (const [text, urls] of content) {
    if (urls.length < 2) continue;
    for (const url of urls) {
      const c = check(
        "content.duplicate",
        "Content",
        url,
        "info",
        false,
        "Identical main-content candidate",
        { urls, characters: text.length, excerpt: text.slice(0, 300) },
        "Review whether these pages should be distinct or consolidated. Shared content is not automatically an SEO error.",
      );
      c.confidence = "heuristic";
      result.push(c);
    }
  }
  return result;
}
