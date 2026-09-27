import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { check, docs } from "./check.js";
import { localUrl } from "./url.js";
import { directiveValues, noindex } from "./rules.js";
import type { Check, Options, Page } from "./types.js";

export function similarity(a: string, b: string): number {
  const shingles = (s: string) => {
    const words =
      s
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    return new Set(
      words
        .slice(0, 10000)
        .slice(0, -3)
        .map((_, i) => words.slice(i, i + 4).join(" ")),
    );
  };
  const x = shingles(a),
    y = shingles(b);
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

export async function siteRules(pages: Page[], o: Options): Promise<Check[]> {
  const checks: Check[] = [];
  const good = pages.filter(
    (p) => p.status === 200 && !p.error && (p.rendered || p.raw),
  );
  const snap = (p: Page) => p.rendered ?? p.raw!;
  const edges = new Map(
    good.map((p) => [
      p.url,
      [
        ...new Set(
          snap(p)
            .links.map((u) => localUrl(u, o, p.url))
            .filter((u): u is string => !!u),
        ),
      ],
    ]),
  );
  const distances = new Map<string, number>();
  distances.set(localUrl(o.url, o)!, 0);
  const queue = [...distances.keys()];
  for (let i = 0; i < queue.length; i++) {
    for (const next of edges.get(queue[i]) ?? [])
      if (!distances.has(next)) {
        distances.set(next, distances.get(queue[i])! + 1);
        queue.push(next);
      }
  }
  for (const p of good) {
    const s = snap(p),
      t = s.technical;
    const emit = (
      rule: string,
      category: string,
      valid: boolean | "inconclusive" | "skipped",
      message: string,
      evidence: unknown,
      remediation: string,
      heuristic = false,
    ) => {
      checks.push({
        ...check(
          rule,
          category,
          p.url,
          heuristic ? "info" : "warning",
          valid,
          message,
          evidence,
          remediation,
        ),
        confidence: heuristic
          ? "heuristic"
          : valid === "inconclusive"
            ? "unverified"
            : "observed",
      });
    };
    const incoming = [...edges]
      .filter(([url, links]) => url !== p.url && links.includes(p.url))
      .map(([url]) => url);
    emit(
      "links.navigation-depth",
      "Architecture",
      distances.has(p.url) && distances.get(p.url)! <= 3,
      "Internal navigation depth and incoming links",
      {
        navigationDepth: distances.get(p.url) ?? null,
        discoveryDepth: p.depth,
        incoming,
        note: "Measured from audit start URL through crawled links; missing paths may exist outside crawl scope. Three clicks is a review threshold, not a Google rule.",
      },
      "Review important pages without incoming links or with unnecessarily long navigation paths.",
      true,
    );
    const byPath = new Map<string, Set<string>>();
    for (const value of s.links) {
      const u = localUrl(value, o, p.url);
      if (!u) continue;
      const parsed = new URL(u);
      if (!parsed.search) continue;
      if (!byPath.has(parsed.pathname)) byPath.set(parsed.pathname, new Set());
      byPath.get(parsed.pathname)!.add(parsed.search);
    }
    const traps = [...byPath]
      .filter(([, queries]) => queries.size >= 10)
      .map(([path, queries]) => ({
        path,
        variants: queries.size,
        examples: [...queries].slice(0, 10),
      }));
    emit(
      "crawl.query-traps",
      "Architecture",
      !traps.length,
      "Query and faceted navigation growth",
      traps,
      "Decide which filter combinations deserve crawling; avoid unlimited parameter combinations.",
      true,
    );
    const directives = directiveValues(p, s).join(",");
    emit(
      "robots.noindex-blocked",
      "Indexing",
      !(p.robotsDisallowed && /\b(noindex|none)\b/i.test(directives)),
      "Noindex must be accessible to crawlers",
      { robotsDisallowed: p.robotsDisallowed, directives },
      "Allow crawling for Google to discover noindex; robots.txt blocking alone does not remove a URL from search.",
    );
    const bad: string[] = [];
    for (const match of directives.matchAll(
      /\b(max-snippet|max-video-preview|max-image-preview)\s*:\s*([^,;]+)/gi,
    )) {
      const value = match[2].trim().toLowerCase();
      if (
        match[1].toLowerCase() === "max-image-preview"
          ? !["none", "standard", "large"].includes(value)
          : !/^(?:-1|\d+)$/.test(value)
      )
        bad.push(match[0]);
    }
    const unsupported =
      t?.snippetElements.filter(
        (e) => !["span", "div", "section"].includes(e.tag),
      ) ?? [];
    emit(
      "robots.snippet-values",
      "Indexing",
      !bad.length && !unsupported.length,
      "Snippet directive values and data-nosnippet elements",
      { invalid: bad, unsupported },
      "Use documented snippet values and data-nosnippet on span, div or section.",
    );
    const conflicts =
      /\bnosnippet\b/i.test(directives) &&
      /\bmax-snippet\s*:\s*(?:[1-9]\d*|-1)\b/i.test(directives);
    emit(
      "robots.snippet-precedence",
      "Indexing",
      !conflicts,
      "Overlapping snippet directives",
      {
        directives,
        note: "Google applies the more restrictive directive; overlap is not invalid markup.",
      },
      "Remove contradictory intent; nosnippet takes precedence over a positive max-snippet.",
      true,
    );
    if (!t) continue;
    emit(
      "html.head-structure",
      "Metadata",
      !p.raw?.technical?.headIssues.length,
      "Invalid elements inside source head",
      p.raw?.technical?.headIssues ?? [],
      "Keep head limited to valid metadata elements. Intentional Next.js metadata streamed into body is not flagged by this rule.",
    );
    const bytes = p.raw?.technical?.bytes ?? t.bytes;
    emit(
      "crawl.fetch-size",
      "Crawling",
      bytes <= 2 * 1024 * 1024,
      "HTML exceeds Googlebot 2 MB fetch limit",
      {
        bytes,
        limitBytes: 2 * 1024 * 1024,
        importantElementsAfterLimit: p.raw?.technical?.contentAfterLimit,
      },
      "Reduce response size and keep essential content and metadata within the fetched HTML prefix.",
    );
    const images = t.responsiveImages.filter(
      (i) =>
        !i.src ||
        (/\d+w\b/.test(i.srcset) && !i.sizes) ||
        (i.width !== undefined && !/^\d+(?:\.\d+)?$/.test(i.width)) ||
        (i.height !== undefined && !/^\d+(?:\.\d+)?$/.test(i.height)),
    );
    const srcsetIssues = t.srcsets?.filter((set) => set.issues.length) ?? [];
    emit(
      "images.srcset",
      "Images",
      !srcsetIssues.length,
      "Responsive image candidate syntax",
      srcsetIssues,
      "Use unique positive width or density descriptors, without mixing them in one srcset.",
    );
    emit(
      "images.responsive-markup",
      "Images",
      !images.length,
      "Image fallback, responsive sizes and dimension syntax",
      images,
      "Provide an img src fallback, sizes for width-descriptor srcset, and valid intrinsic dimensions.",
    );
    const pagination = t.pagination.map((l) => ({
      ...l,
      target: localUrl(l.url, o, p.url),
    }));
    const broken = pagination.filter(
      (l) =>
        l.target && pages.some((q) => q.url === l.target && q.status >= 400),
    );
    emit(
      "pagination.targets",
      "Architecture",
      !broken.length,
      "Pagination links must lead to available pages",
      broken,
      "Link sequential pages with real anchor URLs; rel=next/prev is not required by Google.",
    );
    const pageNumber =
      new URL(p.url).searchParams.get("page") ??
      new URL(p.url).pathname.match(/\/page\/(\d+)\/?$/)?.[1];
    if (pageNumber && Number(pageNumber) > 1) {
      const canonical = s.canonicals[0] && localUrl(s.canonicals[0], o, p.url);
      emit(
        "pagination.canonical",
        "Architecture",
        !canonical || canonical === p.url,
        "Paginated URL canonical points to another page",
        { canonical, pageNumber },
        "Use distinct canonical URLs for genuinely different result pages; review intentional duplicates.",
        true,
      );
    }
  }
  const candidates = good
    .filter((p) => !noindex(p) && (snap(p).mainText?.length ?? 0) >= 200)
    .slice(0, 250);
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i],
      matches: { url: string; similarity: number }[] = [];
    for (const q of candidates.slice(i + 1)) {
      const a = snap(p).mainText!,
        b = snap(q).mainText!;
      if (
        Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.7 ||
        a === b
      )
        continue;
      const value = similarity(a, b);
      if (value >= 0.85)
        matches.push({ url: q.url, similarity: Math.round(value * 100) });
    }
    if (matches.length)
      checks.push({
        ...check(
          "content.near-duplicate",
          "Content",
          p.url,
          "info",
          false,
          "Very similar main content",
          {
            matches,
            method:
              "4-word shingle Jaccard ≥85%, first 10,000 words; first 250 eligible pages",
            excerpt: snap(p).mainText!.slice(0, 300),
          },
          "Review whether these are useful distinct pages or duplicate URL variants.",
        ),
        confidence: "heuristic",
      });
  }
  if (good.length > 250)
    checks.push(
      check(
        "content.near-duplicate-coverage",
        "Content",
        o.url,
        "info",
        "inconclusive",
        "Near-duplicate comparison capped at 250 eligible pages",
        { pages: good.length },
        "Narrow the audit scope for a complete pairwise comparison.",
      ),
    );
  checks.push(...(await manifestRules(pages, o)));
  return checks;
}

async function manifestRules(pages: Page[], o: Options): Promise<Check[]> {
  const result: Check[] = [];
  const emit = (
    valid: boolean | "skipped" | "inconclusive",
    evidence: unknown,
  ) =>
    result.push(
      check(
        "routes.manifest",
        "Architecture",
        o.url,
        "info",
        valid,
        "Build routes compared with crawled routes",
        evidence,
        "Build the project, pass --project-dir and seed missing public routes. Dynamic templates require concrete route URLs.",
      ),
    );
  if (!o.projectDir) {
    emit(
      "skipped",
      "No project directory supplied; source code is never executed.",
    );
    return result;
  }
  const root = resolve(o.projectDir),
    routes = new Set<string>(),
    files: string[] = [],
    errors: string[] = [];
  for (const name of [
    ".next/server/pages-manifest.json",
    ".next/server/app-paths-manifest.json",
    ".next/prerender-manifest.json",
    ".next/routes-manifest.json",
  ]) {
    try {
      const text = await readFile(join(root, name), "utf8");
      if (text.length > 8 * 1024 * 1024)
        throw new Error("manifest exceeds 8 MiB");
      const data = JSON.parse(text);
      files.push(name);
      const keys = name.includes("prerender")
        ? Object.keys(data.routes ?? {})
        : name.includes("routes-manifest")
          ? (data.staticRoutes ?? []).map((r: { page: string }) => r.page)
          : Object.keys(data);
      for (let route of keys) {
        if (name.includes("app-paths")) {
          if (!route.endsWith("/page")) continue;
          route = route.replace(/\/page$/, "").replace(/\/\([^/]+\)/g, "");
        }
        if (/\[|\]|@|^\/(?:api(?:\/|$)|_|404$|500$)/.test(route)) continue;
        routes.add(route || "/");
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  let visited = 0;
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 10000)
        throw new Error("Static export entry budget reached");
      if (entry.isDirectory() && entry.name !== "_next")
        await walk(join(dir, entry.name), prefix + entry.name + "/");
      if (
        entry.isFile() &&
        entry.name.endsWith(".html") &&
        !["404.html", "500.html"].includes(entry.name)
      )
        routes.add(
          (prefix + entry.name)
            .replace(/index\.html$/, "")
            .replace(/\.html$/, "") || "/",
        );
    }
  };
  try {
    await walk(join(root, "out"), "/");
    files.push("out/**/*.html");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      errors.push((e as Error).message);
  }
  const path = (value: string) =>
    new URL(value, o.url).pathname.replace(/\/$/, "") || "/";
  const crawled = new Set(
    pages.filter((p) => p.status === 200).map((p) => path(p.url)),
  );
  const missing = [...routes].filter((r) => !crawled.has(path(r)));
  emit(
    errors.length || !files.length
      ? "inconclusive"
      : missing.length
        ? "inconclusive"
        : true,
    {
      files,
      errors,
      publicRoutes: routes.size,
      notSeen: missing,
      note: "Build outputs may be stale. API handlers, dynamic templates and internal framework routes are excluded; notSeen is not proof of an orphan.",
    },
  );
  return result;
}
