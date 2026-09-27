import { check, docs } from "./check.js";
import { Http, type CrawlResult } from "./crawl.js";
import { glob } from "./config.js";
import { localUrl, normalize, publicUrl } from "./url.js";
import type { Check, Options, Page, Snapshot } from "./types.js";
export function directiveValues(p: Page, s = p.rendered ?? p.raw): string[] {
  // Apply generic and Googlebot-specific header directives, not directives for unrelated bots.
  const tokens: string[] = [];
  for (const content of s?.robots ?? [])
    tokens.push(...content.toLowerCase().split(","));
  let applicable = true;
  for (let token of (p.headers["x-robots-tag"] ?? "")
    .toLowerCase()
    .split(",")) {
    const scope = /^\s*([\w-]+):\s*(.*)$/.exec(token);
    if (
      scope &&
      ![
        "max-snippet",
        "max-image-preview",
        "max-video-preview",
        "unavailable_after",
      ].includes(scope[1])
    ) {
      applicable = scope[1] === "googlebot";
      token = scope[2];
    }
    if (applicable) tokens.push(token.trim());
  }
  return tokens;
}
export function directives(p: Page, s = p.rendered ?? p.raw): string[] {
  return directiveValues(p, s).flatMap((value) => value.trim().split(/\s+/));
}
export const noindex = (p: Page) =>
  directives(p).some((t) => ["noindex", "none"].includes(t));
function validLang(s: string) {
  try {
    return (
      /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(s) &&
      !!Intl.getCanonicalLocales(s).length
    );
  } catch {
    return false;
  }
}
export function validHreflang(value: string): boolean {
  if (value.toLowerCase() === "x-default") return true;
  const match = /^([a-z]{2})(?:-([a-z]{4}))?(?:-([a-z]{2}))?$/i.exec(value);
  if (!match || !validLang(value)) return false;
  const language = match[1].toLowerCase(),
    region = match[3]?.toUpperCase();
  const names = new Intl.DisplayNames(["en"], {
    type: "language",
    fallback: "code",
  });
  if (names.of(language) === language) return false;
  if (region) {
    if (["UK", "EU", "UN", "ZZ"].includes(region)) return false;
    if (
      new Intl.DisplayNames(["en"], { type: "region", fallback: "code" }).of(
        region,
      ) === region
    )
      return false;
  }
  return true;
}
export function semanticJson(value: string): string {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  try {
    return JSON.stringify(sort(JSON.parse(value)));
  } catch {
    return value;
  }
}
export async function coreRules(
  crawl: CrawlResult,
  o: Options,
): Promise<Check[]> {
  const checks: Check[] = [];
  const pages = new Map(crawl.pages.map((p) => [p.url, p]));
  const add = (...args: Parameters<typeof check>) =>
    checks.push(check(...args));
  const targets = new Map<
    string,
    Promise<{
      status: number;
      error?: string;
      headers: Record<string, string>;
      redirects: string[];
    }>
  >();
  const http = new Http(o);
  const probe = (value: string) => {
    const url = localUrl(value, o);
    if (!url) return undefined;
    const p = pages.get(url);
    if (p && !p.blocked) return Promise.resolve(p);
    // Avoid bypassing robots/exclusions or configured crawl limits during validation.
    return targets.get(url);
  };
  try {
    for (const p of crawl.pages) {
      add(
        "robots.blocked",
        "Indexability",
        p.url,
        "warning",
        !(p.robotsDisallowed ?? p.blocked),
        "Page blocked by robots.txt",
        {
          disallowed: p.robotsDisallowed ?? p.blocked ?? false,
          ignored: o.ignoreRobots,
        },
        "Review crawl restrictions; use --ignore-robots to inspect blocked pages.",
        docs + "crawling-indexing/robots/intro",
      );
      if (p.blocked) {
        if (crawl.sitemapUrls.includes(p.url))
          add(
            "sitemap.blocked",
            "Indexability",
            p.url,
            "error",
            false,
            "Sitemap entry blocked by robots.txt",
            p.url,
            "Remove the entry or allow crawling if this page should be indexed.",
          );
        add(
          "page.audit",
          "Crawling",
          p.url,
          "info",
          "skipped",
          "Page audit skipped due to robots.txt",
          null,
          "Review robots.txt or explicitly opt into --ignore-robots.",
        );
        continue;
      }
      add(
        "http.status",
        "HTTP",
        p.url,
        "error",
        p.status >= 200 && p.status < 400 && !p.error,
        "HTTP accessibility",
        { status: p.status, error: p.error },
        "Repair the route or redirect so it is accessible.",
      );
      add(
        "http.redirect-chain",
        "HTTP",
        p.url,
        "warning",
        p.redirects.length <= 1,
        "Redirect chain",
        p.redirects,
        "Link directly to the final URL.",
      );
      add(
        "http.redirect-loop",
        "HTTP",
        p.url,
        "error",
        !p.error?.match(/redirect loop|10 redirects/i),
        "Redirect loop or hop limit",
        p.error ?? null,
        "Remove looping or excessive redirects.",
      );
      add(
        "http.content-type",
        "HTTP",
        p.url,
        "info",
        !!p.raw,
        "HTML audit applicability",
        p.headers["content-type"] ?? "",
        "Serve HTML content with a matching content type; non-HTML resources have no page SEO checks.",
      );
      const s = p.rendered ?? p.raw;
      if (!s) continue;
      if (p.status < 200 || p.status >= 400 || p.error) {
        if (crawl.sitemapUrls.includes(p.url))
          add(
            "sitemap.indexability",
            "Indexability",
            p.url,
            "error",
            false,
            "Sitemap target status/indexability",
            { status: p.status },
            "Remove failed URLs from the sitemap or repair the route.",
          );
        add(
          "page.seo-applicability",
          "Crawling",
          p.url,
          "info",
          "skipped",
          "Page SEO checks skipped for unsuccessful response",
          { status: p.status },
          "Resolve the HTTP failure before checking page metadata.",
        );
        continue;
      }
      const d = directives(p, s);
      const indexable = !noindex(p);
      add(
        "index.noindex",
        "Indexability",
        p.url,
        "info",
        indexable,
        "Indexing directive",
        d,
        "Confirm whether this page should be indexed; intentional noindex is valid.",
        docs + "crawling-indexing/robots-meta-tag",
      );
      add(
        "index.conflicting",
        "Indexability",
        p.url,
        "warning",
        !(
          d.includes("index") && d.some((t) => ["noindex", "none"].includes(t))
        ) &&
          !(
            d.includes("follow") &&
            d.some((t) => ["nofollow", "none"].includes(t))
          ),
        "Conflicting robots directives",
        d,
        "Remove contradictory directives; restrictive directives take precedence.",
      );
      for (const [kind, values] of [
        ["title", s.titles],
        ["description", s.descriptions],
      ] as const) {
        add(
          `${kind}.present`,
          "Metadata",
          p.url,
          kind === "title" ? "error" : "warning",
          values.some((v) => v.trim()),
          `${kind} presence`,
          values,
          `Provide a descriptive ${kind}.`,
        );
        add(
          `${kind}.multiple`,
          "Metadata",
          p.url,
          "warning",
          values.length <= 1,
          `Multiple ${kind} elements`,
          values,
          `Keep one authoritative ${kind} element.`,
        );
      }
      add(
        "canonical.present",
        "Canonical",
        p.url,
        "info",
        s.canonicals.length > 0,
        "Canonical declaration",
        s.canonicals,
        "Declare the preferred public URL when canonicalization is needed.",
        docs + "crawling-indexing/consolidate-duplicate-urls",
      );
      add(
        "canonical.multiple",
        "Canonical",
        p.url,
        "error",
        new Set(s.canonicals).size <= 1,
        "Conflicting canonical declarations",
        s.canonicals,
        "Keep HTML and HTTP canonical declarations consistent.",
      );
      for (const canonical of s.canonicals) {
        add(
          "canonical.url",
          "Canonical",
          p.url,
          "error",
          !!normalize(canonical),
          "Canonical URL validity",
          canonical,
          "Use a valid HTTP(S) canonical URL.",
        );
        if (o.productionOrigin && normalize(canonical))
          add(
            "canonical.local-origin",
            "Canonical",
            p.url,
            "warning",
            new URL(canonical).origin !== new URL(o.url).origin,
            "Canonical public-origin check",
            canonical,
            "Emit the intended production URL, not localhost.",
          );
        const target = await probe(canonical);
        add(
          "canonical.target",
          "Canonical",
          p.url,
          "error",
          target ? target.status === 200 && !target.error : "inconclusive",
          "Canonical target accessibility",
          { canonical, status: target?.status },
          "Ensure the canonical target is accessible; unvisited or external targets are not verified.",
        );
        const tp = pages.get(localUrl(canonical, o) ?? "");
        if (tp?.raw && indexable)
          add(
            "canonical.indexability",
            "Canonical",
            p.url,
            "error",
            !noindex(tp),
            "Canonical target indexability",
            canonical,
            "Point canonical URLs to indexable pages.",
          );
        const chain = new Set<string>([p.url]);
        let next = localUrl(canonical, o);
        let loop = false;
        let incomplete = !next;
        while (next && next !== p.url && !chain.has(next)) {
          chain.add(next);
          const t = pages.get(next);
          if (!t || t.blocked || !(t.rendered ?? t.raw)) incomplete = true;
          const v = (t?.rendered ?? t?.raw)?.canonicals[0];
          const n = v ? localUrl(v, o) : undefined;
          if (v && !n) incomplete = true;
          if (n === next) {
            next = undefined;
            break;
          }
          next = n;
        }
        if (next && chain.size > 1 && chain.has(next)) loop = true;
        add(
          "canonical.loop",
          "Canonical",
          p.url,
          "error",
          loop ? false : incomplete ? "inconclusive" : true,
          "Canonical loop",
          { canonical, chain: [...chain] },
          "Resolve circular canonical references to one preferred page.",
        );
      }
      add(
        "heading.h1",
        "Structure",
        p.url,
        "warning",
        s.headings.some((h) => h.level === 1 && h.text),
        "Descriptive H1 presence",
        s.headings.filter((h) => h.level === 1),
        "Add an appropriate main heading.",
      );
      const skips = s.headings.filter(
        (h, i) => i > 0 && h.level > s.headings[i - 1].level + 1,
      );
      add(
        "heading.hierarchy",
        "Structure",
        p.url,
        "info",
        !skips.length,
        "Heading level jumps",
        skips,
        "Review heading hierarchy for readability and accessibility.",
      );
      add(
        "html.language",
        "Structure",
        p.url,
        "warning",
        validLang(s.lang),
        "Document language",
        s.lang,
        "Set a valid language tag on the html element.",
      );
      add(
        "html.viewport",
        "Structure",
        p.url,
        "warning",
        /width\s*=\s*device-width/i.test(s.viewport),
        "Responsive viewport",
        s.viewport,
        "Use a viewport declaration appropriate for responsive pages.",
      );
      add(
        "html.charset",
        "Structure",
        p.url,
        "warning",
        s.charset || /charset=/i.test(p.headers["content-type"] ?? ""),
        "Character encoding declaration",
        p.headers["content-type"],
        "Declare the document character encoding.",
      );
      add(
        "html.refresh",
        "HTTP",
        p.url,
        "warning",
        !s.refresh.length,
        "Meta refresh navigation",
        s.refresh,
        "Prefer an HTTP redirect when redirecting a page.",
      );
      const missing = s.images.filter((i) => i.alt === undefined);
      add(
        "image.alt",
        "Images",
        p.url,
        "warning",
        !missing.length,
        "Missing image alt attributes",
        missing,
        'Provide descriptive alt text, or alt="" for decorative images.',
      );
      const internal = [
        ...new Set(
          s.links.map((v) => localUrl(v, o)).filter((v): v is string => !!v),
        ),
      ];
      const broken = internal.filter((u) => {
        const t = pages.get(u);
        return t && !t.blocked && (t.status >= 400 || t.status === 0);
      });
      const unchecked = internal.filter(
        (u) => !pages.has(u) || pages.get(u)?.blocked,
      );
      add(
        "links.broken",
        "Links",
        p.url,
        "error",
        broken.length ? false : unchecked.length ? "inconclusive" : true,
        "Internal link accessibility",
        { broken, unchecked },
        "Repair broken destinations; unchecked destinations need additional crawl coverage.",
      );
      add(
        "links.redirect",
        "Links",
        p.url,
        "info",
        !internal.some((u) => pages.get(u)?.redirects.length),
        "Internal links through redirects",
        internal.filter((u) => pages.get(u)?.redirects.length),
        "Link directly to final destinations.",
      );
      for (const alternate of s.hreflang) {
        add(
          "hreflang.language",
          "Internationalization",
          p.url,
          "error",
          validHreflang(alternate.lang),
          "hreflang language tag",
          alternate,
          "Use supported language/region codes or x-default.",
        );
        const t = pages.get(localUrl(alternate.href, o) ?? "");
        const ts = t?.rendered ?? t?.raw;
        add(
          "hreflang.target",
          "Internationalization",
          p.url,
          "error",
          t && !t.blocked ? t.status === 200 && !noindex(t) : "inconclusive",
          "hreflang target accessibility",
          alternate,
          "Use indexable, accessible alternate pages.",
        );
        add(
          "hreflang.reciprocal",
          "Internationalization",
          p.url,
          "warning",
          ts
            ? ts.hreflang.some((h) => localUrl(h.href, o) === p.url)
            : "inconclusive",
          "Reciprocal hreflang",
          alternate,
          "Include return references between alternate pages.",
        );
        if (ts?.canonicals.length)
          add(
            "hreflang.canonical",
            "Internationalization",
            p.url,
            "warning",
            ts.canonicals.some((c) => localUrl(c, o) === t!.url),
            "Alternate canonical consistency",
            { alternate, canonicals: ts.canonicals },
            "Reference canonical versions of alternate pages.",
          );
      }
      const isSitemap = crawl.sitemapUrls.includes(p.url);
      if (isSitemap) {
        add(
          "sitemap.indexability",
          "Indexability",
          p.url,
          "error",
          indexable && p.status === 200 && !p.redirects.length,
          "Sitemap target status/indexability",
          { status: p.status, directives: d, redirects: p.redirects },
          "List canonical, indexable 200 URLs in sitemaps.",
        );
        add(
          "sitemap.canonical",
          "Canonical",
          p.url,
          "warning",
          !s.canonicals.length ||
            s.canonicals.some((c) => localUrl(c, o) === p.url),
          "Sitemap canonical consistency",
          s.canonicals,
          "List the preferred canonical URL.",
        );
        add(
          "discovery.orphan",
          "Discovery",
          p.url,
          "info",
          p.discoveredBy.some(
            (x) => x !== "sitemap" && !x.startsWith("validation:"),
          ),
          "Sitemap-only orphan candidate",
          p.discoveredBy,
          "Add relevant internal links; this is limited to observed crawl coverage.",
        );
      }
      const og = Object.keys(s.social).some((k) => k.startsWith("og:"));
      const tw = Object.keys(s.social).some((k) => k.startsWith("twitter:"));
      add(
        "social.og",
        "Sharing",
        p.url,
        "info",
        ["og:title", "og:type", "og:image", "og:url"].every((k) => s.social[k]),
        "Open Graph completeness",
        s.social,
        "Supply core Open Graph properties for consistent previews.",
        "https://ogp.me/",
      );
      add(
        "social.twitter",
        "Sharing",
        p.url,
        "info",
        tw
          ? !!s.social["twitter:card"] &&
              !!(s.social["twitter:title"] || s.social["og:title"])
          : "skipped",
        "Twitter Card completeness",
        s.social,
        "Declare a card type and title; supported Open Graph fallbacks are accepted.",
      );
      if (og && s.social["og:url"])
        add(
          "social.url",
          "Sharing",
          p.url,
          "warning",
          normalize(s.social["og:url"]) ===
            normalize(publicUrl(p.finalUrl, o)) ||
            s.canonicals.includes(s.social["og:url"]),
          "Social URL consistency",
          s.social["og:url"],
          "Use the intended public/canonical page URL.",
        );
      for (const key of ["og:image", "twitter:image"])
        if (s.social[key]) {
          const target = localUrl(s.social[key], o, p.finalUrl);
          let r;
          // Image validation is bounded and never forwards credentials to another origin.
          if (
            target &&
            crawl.canFetch?.(target) !== false &&
            !o.exclude.some(
              (v) => glob(target, v) || glob(new URL(target).pathname, v),
            )
          ) {
            if (!targets.has(target))
              targets.set(target, http.get(target, crawl.canFetch));
            r = await targets.get(target);
          }
          add(
            "social.image",
            "Sharing",
            p.url,
            "warning",
            r
              ? r.status === 200 &&
                  /^image\//i.test(r.headers["content-type"] ?? "")
              : "inconclusive",
            "Social image accessibility",
            { key, url: s.social[key], status: r?.status },
            "Use a reachable image URL; external image URLs are not fetched.",
          );
        }
      add(
        "render.success",
        "Rendering",
        p.url,
        "error",
        o.render === "off" ? "skipped" : !!p.rendered,
        "Browser rendering",
        p.renderError ?? null,
        "Resolve browser failures; use --wait-selector for delayed content.",
      );
      if (p.raw && p.rendered) {
        const r = p.raw,
          v = p.rendered;
        for (const [id, raw, rendered] of [
          [
            "metadata",
            {
              titles: r.titles,
              descriptions: r.descriptions,
              canonicals: r.canonicals,
              robots: r.robots,
            },
            {
              titles: v.titles,
              descriptions: v.descriptions,
              canonicals: v.canonicals,
              robots: v.robots,
            },
          ],
          ["links", [...new Set(r.links)].sort(), [...new Set(v.links)].sort()],
          [
            "structured",
            r.structured
              .filter((b) => b.format === "jsonld")
              .map((b) => semanticJson(b.value))
              .sort(),
            v.structured
              .filter((b) => b.format === "jsonld")
              .map((b) => semanticJson(b.value))
              .sort(),
          ],
        ] as const) {
          add(
            `render.${id}`,
            "Rendering",
            p.url,
            "info",
            JSON.stringify(raw) === JSON.stringify(rendered),
            `Raw/rendered ${id} differences`,
            { raw, rendered },
            "Review JavaScript-dependent changes; differences alone do not prove an indexing failure.",
          );
        }
        add(
          "render.content",
          "Rendering",
          p.url,
          "info",
          r.text === v.text,
          "Raw/rendered content differences",
          {
            raw: r.text.slice(0, 2000),
            rendered: v.text.slice(0, 2000),
            rawLength: r.text.length,
            renderedLength: v.text.length,
          },
          "Ensure important content can be discovered and rendered by target crawlers.",
        );
        add(
          "render.errors",
          "Rendering",
          p.url,
          "warning",
          !p.consoleErrors.length,
          "Uncaught browser errors",
          p.consoleErrors,
          "Fix browser errors that may prevent content rendering.",
        );
        add(
          "render.indexability",
          "Indexability",
          p.url,
          "error",
          !directives(p, r).some((t) => ["none", "noindex"].includes(t)) ||
            directives(p, v).some((t) => ["none", "noindex"].includes(t)),
          "JavaScript removal of initial noindex",
          { raw: r.robots, rendered: v.robots },
          "Remove unintended noindex from the server response; crawlers may skip rendering it.",
        );
      }
    }
    for (const [kind, get] of [
      ["title", (s: Snapshot) => s.titles[0]],
      ["description", (s: Snapshot) => s.descriptions[0]],
    ] as const) {
      const groups = new Map<string, string[]>();
      for (const p of crawl.pages) {
        const s = p.rendered ?? p.raw;
        if (!s || noindex(p) || p.redirects.length || p.status !== 200)
          continue;
        const key = get(s)?.trim();
        if (key) groups.set(key, [...(groups.get(key) ?? []), p.url]);
      }
      for (const [value, urls] of groups)
        for (const url of urls)
          add(
            `${kind}.duplicate`,
            "Metadata",
            url,
            "warning",
            urls.length === 1,
            `Cross-page duplicate ${kind}`,
            { value, urls },
            `Review duplicate ${kind}s across indexable pages.`,
          );
    }
    return checks;
  } finally {
    await http.close();
  }
}
