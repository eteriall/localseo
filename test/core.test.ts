import { describe, it, expect } from "vitest";
import { extract } from "../src/extract.js";
import { validateOptions, glob } from "../src/config.js";
import { localUrl, normalize, publicUrl } from "../src/url.js";
import { directives } from "../src/rules.js";
import { audit as fullAudit } from "../src/index.js";
const audit = (input: Parameters<typeof fullAudit>[0]) =>
  fullAudit({ ...input, advanced: false });
import { exitCode, htmlReport, redact } from "../src/report.js";
import { html, fixture } from "./fixtures.js";
import type { Page } from "../src/types.js";
describe("extraction and configuration", () => {
  it("does not treat same-document fragment navigation as another page link", () => {
    const s = extract(
      html(
        '<a href="#main">Skip</a><a href="http://localhost/missing#main">Same page</a><a href="/other#main">Other page</a>',
      ),
      "http://localhost/missing",
    );
    expect(s.links).toEqual(["http://localhost/other#main"]);
    const withBase = extract(
      html(
        '<a href="#main">Other document</a>',
        '<base href="http://localhost/other">',
      ),
      "http://localhost/missing",
    );
    expect(withBase.links).toEqual(["http://localhost/other#main"]);
  });
  it("preserves navigation, decorative alt, JSON-LD and full streamed metadata", () => {
    const s = extract(
      html(
        '<nav><a href="/next">Next</a><img src="/logo" alt=""></nav><script type="application/ld+json">{}</script>',
      ),
      "http://localhost/",
    );
    expect(s.links).toContain("http://localhost/next");
    expect(s.images[0].alt).toBe("");
    expect(s.structured[0].value).toBe("{}");
    expect(
      extract(
        "<html><head></head><body><title>Late</title></body></html>",
        "http://localhost/",
      ).titles,
    ).toEqual(["Late"]);
  });
  it("preserves paths and maps only explicit origins", () => {
    const o = validateOptions({
      url: "http://localhost:3000",
      productionOrigin: "https://site.example",
    });
    expect(localUrl("https://site.example/Case/?x=1#fragment", o)).toBe(
      "http://localhost:3000/Case/?x=1",
    );
    expect(publicUrl("http://localhost:3000/Case/", o)).toBe(
      "https://site.example/Case/",
    );
    expect(localUrl("https://other.example/", o)).toBeUndefined();
    expect(normalize("javascript:alert(1)")).toBeUndefined();
    expect(() => validateOptions({ url: o.url, maxPages: 0 })).toThrow();
    expect(() =>
      validateOptions({ url: "http://user:pass@localhost" }),
    ).toThrow();
    expect(glob("/articles/one", "/articles/*")).toBe(true);
    expect(glob("/articles/a/b", "/articles/*")).toBe(false);
  });
  it("distinguishes bot-specific headers", () => {
    const p = {
      headers: {
        "x-robots-tag": "otherbot: noindex, googlebot: max-snippet:20, index",
      },
    } as unknown as Page;
    expect(directives(p)).not.toContain("noindex");
    expect(directives(p)).toContain("index");
  });
  it("redacts credentials and query tokens recursively", () =>
    expect(
      redact({ value: "Bearer secret https://x/?token=abc" }, [
        "Bearer secret",
      ]),
    ).toEqual({ value: "[REDACTED] https://x/?token=[REDACTED]" }));
});
describe("full HTTP audit", () => {
  it("discovers sitemaps, reports robots/noindex/broken links and does not claim unvisited targets passed", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin,
        render: "off",
        headers: { Authorization: "Bearer fixture-secret" },
      });
      expect(r.pages.some((p) => p.url.endsWith("/orphan"))).toBe(true);
      expect(r.pages.find((p) => p.url.endsWith("/blocked"))?.blocked).toBe(
        true,
      );
      expect(site.requests.some((r) => r.url === "/blocked")).toBe(false);
      expect(r.pages.some((p) => p.url.includes("?"))).toBe(false);
      expect(
        r.checks.some(
          (c) =>
            c.rule === "sitemap.indexability" &&
            c.url.endsWith("/noindex") &&
            c.outcome === "failed",
        ),
      ).toBe(true);
      expect(
        r.checks.some(
          (c) => c.rule === "links.broken" && c.outcome === "failed",
        ),
      ).toBe(true);
      expect(
        r.checks.some(
          (c) =>
            c.rule === "discovery.orphan" &&
            c.url.endsWith("/orphan") &&
            c.outcome === "failed",
        ),
      ).toBe(true);
      expect(
        r.checks.some(
          (c) => c.rule === "title.duplicate" && c.outcome === "failed",
        ),
      ).toBe(true);
      expect(
        r.checks.some((c) => c.rule === "image.alt" && c.outcome === "failed"),
      ).toBe(false);
      expect(JSON.stringify(r)).not.toContain("fixture-secret");
      expect(r.coverage.complete).toBe(false);
      expect(exitCode(r)).toBe(2);
      const report = htmlReport(r);
      expect(report).toContain("report-data");
      expect(report).toContain("Raw HTML extraction");
    } finally {
      await site.close();
    }
  });
  it("makes page budgets and off-scope redirects explicit", async () => {
    const site = await fixture();
    try {
      const r = await audit({ url: site.origin, render: "off", maxPages: 1 });
      expect(r.coverage.reasons).toContain("Page limit reached");
      const ext = await audit({
        url: site.origin + "/external",
        render: "off",
        exclude: ["/map*"],
        urls: [],
      });
      expect(
        ext.pages.find((p) => p.url.endsWith("/external"))?.error,
      ).toContain("leaves");
    } finally {
      await site.close();
    }
  });
  it("supports explicit query seeds, ignores robots only on opt-in, and suppresses with reasons", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin,
        render: "off",
        urls: ["/query?x=1"],
        ignoreRobots: true,
        suppressions: [
          {
            rule: "title.duplicate",
            urlPattern: "/**",
            reason: "Fixture duplicate",
          },
        ],
      });
      expect(site.requests.some((r) => r.url === "/blocked")).toBe(true);
      expect(r.pages.some((p) => p.url.endsWith("?x=1"))).toBe(true);
      expect(
        r.checks
          .filter((c) => c.rule === "title.duplicate")
          .every((c) => c.suppression === "Fixture duplicate"),
      ).toBe(true);
    } finally {
      await site.close();
    }
  });
});
