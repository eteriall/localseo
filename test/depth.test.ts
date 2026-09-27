import { describe, it, expect } from "vitest";
import { audit as fullAudit } from "../src/index.js";
const audit = (input: Parameters<typeof fullAudit>[0]) =>
  fullAudit({ ...input, advanced: false });
import { extract } from "../src/extract.js";
import { depthRules } from "../src/depth.js";
import { coreRules, validHreflang, semanticJson } from "../src/rules.js";
import { validateOptions } from "../src/config.js";
import { compareReports } from "../src/compare.js";
import { issuesCsv } from "../src/report.js";
import { Http } from "../src/crawl.js";
import { fixture, html } from "./fixtures.js";
import type { Page } from "../src/types.js";
const options = validateOptions({
  url: "http://localhost:3000",
  render: "off",
});
const page = (route = "/", body = html("")): Page => ({
  url: options.url.replace(/\/$/, "") + route,
  publicUrl: options.url,
  finalUrl: options.url,
  status: 200,
  headers: {},
  depth: 0,
  discoveredBy: ["seed"],
  redirects: [],
  consoleErrors: [],
  raw: extract(body, options.url),
});
describe("evidence quality", () => {
  it("decodes gzip sitemap bodies and applies request policy to redirect hops", async () => {
    const site = await fixture();
    const http = new Http(validateOptions({ url: site.origin }));
    try {
      expect(
        (await http.get(site.origin + "/compressed.xml.gz")).body,
      ).toContain("<urlset>");
      expect(
        (
          await http.get(
            site.origin + "/redirect-blocked",
            (u) => !u.endsWith("/blocked"),
          )
        ).error,
      ).toContain("disallowed");
      expect(site.requests.some((r) => r.url === "/blocked")).toBe(false);
    } finally {
      await http.close();
      await site.close();
    }
  });
  it("reports a 200 unknown-route probe as unverified, not a confirmed soft 404", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin,
        render: "off",
        probe404: true,
        exclude: ["/loop-*"],
      });
      expect(
        r.checks.find((c) => c.rule === "http.unknown-route")?.outcome,
      ).toBe("inconclusive");
    } finally {
      await site.close();
    }
  });
  it("validates Google hreflang language/region shapes separately from HTML lang", () => {
    for (const value of ["en", "en-GB", "zh-Hant-TW", "x-default"])
      expect(validHreflang(value)).toBe(true);
    for (const value of [
      "en-UK",
      "en-EU",
      "en-UN",
      "en-ZZ",
      "zz",
      "eng",
      "en-419",
    ])
      expect(validHreflang(value)).toBe(false);
  });
  it("ignores JSON-LD whitespace and property order without reordering lists", () => {
    expect(semanticJson('{"b":2,"a":1}')).toBe(
      semanticJson('{ "a":1, "b":2 }'),
    );
    expect(semanticJson("[1,2]")).not.toBe(semanticJson("[2,1]"));
  });
  it("excludes error-page metadata noise but retains HTTP and sitemap failures", async () => {
    const p = { ...page(), status: 404 };
    const checks = await coreRules(
      {
        pages: [p],
        checks: [],
        reasons: [],
        discovered: 1,
        sitemapUrls: [p.url],
      },
      options,
    );
    expect(checks.find((c) => c.rule === "http.status")?.outcome).toBe(
      "failed",
    );
    expect(checks.find((c) => c.rule === "sitemap.indexability")?.outcome).toBe(
      "failed",
    );
    expect(checks.some((c) => c.rule === "title.present")).toBe(false);
  });
  it("does not pass an unvisited canonical chain", async () => {
    const p = page("/", html("", '<link rel="canonical" href="/unvisited">'));
    const checks = await coreRules(
      { pages: [p], checks: [], reasons: [], discovered: 1, sitemapUrls: [] },
      options,
    );
    expect(checks.find((c) => c.rule === "canonical.loop")?.outcome).toBe(
      "inconclusive",
    );
  });
  it("keeps robots truth when explicitly inspecting blocked pages", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin,
        render: "off",
        ignoreRobots: true,
        exclude: ["/loop-*"],
      });
      const p = r.pages.find((p) => p.url.endsWith("/blocked"))!;
      expect(p.status).toBe(200);
      expect(p.robotsDisallowed).toBe(true);
      expect(
        r.checks.find((c) => c.url === p.url && c.rule === "robots.blocked")
          ?.outcome,
      ).toBe("failed");
    } finally {
      await site.close();
    }
  });
  it("retains anchor evidence and excludes chrome from main content", () => {
    const s = extract(
      html(
        '<nav>Navigation</nav><main>Actual article<a onclick="x()">Action</a><a href="/a"><img alt="Good label"></a><a href="/b"></a></main><footer>Footer</footer>',
      ),
      options.url,
    );
    expect(s.mainText).not.toContain("Navigation");
    expect(s.mainText).not.toContain("Footer");
    expect(s.anchorIssues).toHaveLength(2);
    expect(s.anchorIssues![0].html).toContain("onclick");
  });
  it("labels identical main content as a heuristic and excludes noindex", () => {
    const text = "A substantive article with shared content. ".repeat(20);
    const pages = [
      page("/a", html(text)),
      page("/b", html(text)),
      page("/private", html(text, '<meta name="robots" content="noindex">')),
    ];
    const checks = depthRules(pages, options).filter(
      (c) => c.rule === "content.duplicate",
    );
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.confidence === "heuristic")).toBe(true);
  });
  it("checks alternate conflicts, self reference and public metadata leaks", () => {
    const p = page(
      "/",
      html(
        "",
        '<link rel="alternate" hreflang="en" href="/a"><link rel="alternate" hreflang="en" href="/b"><meta property="og:url" content="http://localhost:3000/">',
      ),
    );
    const checks = depthRules([p], {
      ...options,
      productionOrigin: "https://example.org",
    });
    for (const rule of [
      "hreflang.self",
      "hreflang.conflicts",
      "metadata.local-urls",
    ])
      expect(checks.find((c) => c.rule === rule)?.outcome).toBe("failed");
  });
  it("marks resource inspection skipped without a browser", () => {
    expect(
      depthRules([page()], options).find((c) => c.rule === "render.resources")
        ?.outcome,
    ).toBe("skipped");
  });
  it("normalizes equivalent root URLs in sharing checks", () => {
    const p = page(
      "/",
      html(
        "",
        '<link rel="canonical" href="https://example.org/"><meta property="og:url" content="https://example.org">',
      ),
    );
    expect(
      depthRules([p], options).find((c) => c.rule === "social.canonical")
        ?.outcome,
    ).toBe("passed");
  });
  it("allows a self canonical on an intentionally noindexed page", async () => {
    const p = page(
      "/",
      html(
        "",
        '<meta name="robots" content="noindex"><link rel="canonical" href="http://localhost:3000/">',
      ),
    );
    const checks = await coreRules(
      { pages: [p], checks: [], reasons: [], discovered: 1, sitemapUrls: [] },
      options,
    );
    expect(
      checks.some(
        (c) => c.rule === "canonical.indexability" && c.outcome === "failed",
      ),
    ).toBe(false);
  });
  it("compares baselines across preview ports and protects CSV cells", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin,
        render: "off",
        exclude: ["/loop-*"],
      });
      const next = structuredClone(r);
      const origin = "http://localhost:54321";
      next.settings.url = origin;
      next.checks.forEach((c) => (c.url = c.url.replace(site.origin, origin)));
      expect(compareReports(next, r).added).toEqual([]);
      expect(compareReports(next, r).resolved).toEqual([]);
      next.coverage.complete = false;
      expect(compareReports(next, r).comparable).toBe(false);
      r.checks.push({ ...r.checks[0], message: "=SUM(1)", outcome: "failed" });
      expect(issuesCsv(r)).toContain("'=SUM(1)");
    } finally {
      await site.close();
    }
  });
});
