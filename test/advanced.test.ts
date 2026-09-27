import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { audit, writeReport } from "../src/index.js";
import { htmlReport } from "../src/report.js";
import { seoScore } from "../src/score.js";
import { check } from "../src/check.js";
import { extract, parseSrcset } from "../src/extract.js";
import { fileURLToPath } from "node:url";
import { siteRules, similarity } from "../src/site-rules.js";
import { validateOptions } from "../src/config.js";
import { mimeMatches } from "../src/advanced.js";
import { schemaRules } from "../src/schema.js";
import type { Page } from "../src/types.js";

const origin = "http://localhost:3000";
const page = (path: string, body: string, head = ""): Page => ({
  url: origin + path,
  publicUrl: origin + path,
  finalUrl: origin + path,
  status: 200,
  depth: 0,
  discoveredBy: ["sitemap"],
  headers: {},
  redirects: [],
  consoleErrors: [],
  raw: extract(
    `<html><head><title>Title</title>${head}</head><body>${body}</body></html>`,
    origin + path,
  ),
});
const rule = (
  passed: boolean,
  severity: "error" | "warning" | "info" = "warning",
) => check("example", "Metadata", origin, severity, passed, "Check", {}, "Fix");

describe("SEO Score", () => {
  it("scores passed/failed evidence and exposes all color bands", () => {
    expect(seoScore([rule(true)], true)).toMatchObject({
      value: 100,
      band: "good",
      provisional: false,
    });
    expect(seoScore([rule(false)], true)).toMatchObject({
      value: 0,
      band: "poor",
    });
    expect(
      seoScore([rule(true), { ...rule(false), rule: "second" }], true),
    ).toMatchObject({ value: 50, band: "needs-work" });
  });
  it("does not turn missing evidence, sharing or heuristics into SEO points", () => {
    expect(
      seoScore([{ ...rule(true), outcome: "skipped" }], false),
    ).toMatchObject({ value: null, provisional: true });
    const excluded = [
      { ...rule(false), confidence: "heuristic" as const },
      { ...rule(false), rule: "social.image" },
      { ...rule(false), suppression: "Intentional" },
      rule(false, "info"),
    ];
    expect(seoScore([rule(true), ...excluded], true).value).toBe(100);
  });
  it("deduplicates entities and raw/rendered copies with failure winning", () => {
    const checks = [
      rule(true),
      rule(false),
      ...Array.from({ length: 100 }, () => rule(true)),
    ];
    expect(seoScore(checks, true)).toMatchObject({ value: 0, evaluated: 1 });
  });
  it("weights rules, averages categories and marks unverified results provisional", () => {
    const checks = [
      rule(false, "error"),
      { ...rule(true), rule: "second" },
      { ...rule(true), category: "Images" },
    ];
    expect(seoScore(checks, true).value).toBe(63);
    expect(
      seoScore([...checks, { ...rule(true), outcome: "inconclusive" }], true)
        .provisional,
    ).toBe(true);
  });
});

describe("additional static checks", () => {
  it("parses srcset data URLs, rejects duplicate or mixed descriptors", () => {
    expect(
      parseSrcset("data:image/png;base64,AA== 1x, /big.png 2x").candidates,
    ).toHaveLength(2);
    expect(parseSrcset("/a.png 100w, /b.png 2x").issues).toContain(
      "Mixed width and density descriptors",
    );
    expect(parseSrcset("/a.png 1x, /b.png 1x").issues).toContain(
      "Duplicate candidate descriptors",
    );
    expect(parseSrcset("/a.png 0x").issues).not.toHaveLength(0);
    expect(parseSrcset("/a.png 400w, /b.png 800w").issues).toEqual([]);
  });
  it("reconciles read-only manifests without treating API/dynamic routes as missing pages", async () => {
    const checks = await siteRules(
      [page("/", "Home")],
      validateOptions({
        url: origin,
        projectDir: fileURLToPath(new URL("./projects/next", import.meta.url)),
      }),
    );
    const result = checks.find((c) => c.rule === "routes.manifest")!;
    expect(result.outcome).toBe("inconclusive");
    expect(result.evidence).toMatchObject({
      publicRoutes: 4,
      notSeen: ["/missing", "/about", "/exported/"],
    });
  });
  it("ignores snippet and noindex directives scoped to another crawler", async () => {
    const p = page("/", "Home");
    p.robotsDisallowed = true;
    p.headers["x-robots-tag"] =
      "otherbot: noindex, max-snippet:bananas, googlebot: max-image-preview:large";
    const checks = await siteRules([p], validateOptions({ url: origin }));
    for (const name of ["robots.noindex-blocked", "robots.snippet-values"])
      expect(checks.find((c) => c.rule === name)?.outcome).toBe("passed");
  });
  it("catches parser-breaking head content without rejecting body-streamed metadata", () => {
    expect(
      extract(
        '<head><img src="/x"><meta name="description" content="x"></head><body></body>',
        origin,
      ).technical?.headIssues,
    ).toEqual(["img at line 1"]);
    expect(
      extract(
        '<head></head><body><title>Streamed</title><meta name="description" content="x"></body>',
        origin,
      ).technical?.headIssues,
    ).toEqual([]);
  });
  it("preserves missing src, picture fallback and structured media fields", () => {
    const s = extract(
      '<picture><source srcset="/x.webp 1x"><img alt=""></picture><video src="/v.mp4" poster="/p.jpg"></video>',
      origin,
    );
    expect(s.images[0].src).toBe("");
    expect(s.technical?.responsiveImages[0].picture).toBe(true);
    expect(s.technical?.videos[0]).toMatchObject({
      src: origin + "/v.mp4",
      poster: origin + "/p.jpg",
    });
  });
  it("measures graph depth independently of sitemap discovery depth", async () => {
    const pages = [
      page("/", '<a href="/a">A</a>'),
      page("/a", '<a href="/b">B</a>'),
      page("/b", "B"),
      page("/orphan", "O"),
    ];
    const checks = await siteRules(pages, validateOptions({ url: origin }));
    expect(
      checks.find(
        (c) => c.rule === "links.navigation-depth" && c.url.endsWith("/b"),
      )?.evidence,
    ).toMatchObject({ navigationDepth: 2, discoveryDepth: 0 });
    expect(
      checks.find(
        (c) => c.rule === "links.navigation-depth" && c.url.endsWith("/orphan"),
      )?.evidence,
    ).toMatchObject({ navigationDepth: null, incoming: [] });
  });
  it("checks snippet values, blocked noindex and query growth", async () => {
    const p = page(
      "/",
      "<p data-nosnippet>Hidden snippet</p>" +
        Array.from(
          { length: 11 },
          (_, i) => `<a href="/?color=${i}">Filter</a>`,
        ).join(""),
      '<meta name="robots" content="noindex,nosnippet,max-snippet:10,max-image-preview:huge">',
    );
    p.robotsDisallowed = true;
    const checks = await siteRules([p], validateOptions({ url: origin }));
    for (const name of [
      "robots.snippet-values",
      "robots.noindex-blocked",
      "crawl.query-traps",
      "robots.snippet-precedence",
    ])
      expect(checks.find((c) => c.rule === name)?.outcome).toBe("failed");
    expect(checks.find((c) => c.rule === "crawl.query-traps")?.confidence).toBe(
      "heuristic",
    );
  });
  it("detects content beyond fetch budget and pagination canonical risk", async () => {
    const p = page(
      "/?page=2",
      "x".repeat(2 * 1024 * 1024) + "<main>Important</main>",
      '<link rel="canonical" href="/">',
    );
    const checks = await siteRules([p], validateOptions({ url: origin }));
    expect(checks.find((c) => c.rule === "crawl.fetch-size")).toMatchObject({
      outcome: "failed",
      evidence: { importantElementsAfterLimit: true },
    });
    expect(
      checks.find((c) => c.rule === "pagination.canonical")?.confidence,
    ).toBe("heuristic");
  });
  it("uses shingle similarity rather than matching navigation chrome", () => {
    const text =
      "One original useful article about a fairly detailed topic with lots of distinct words and relevant information.";
    expect(similarity(text, text)).toBe(1);
    expect(
      similarity(
        text,
        "Completely different contents are unrelated to anything from that example.",
      ),
    ).toBe(0);
  });
  it("validates expected resource MIME types", () => {
    expect(mimeMatches("script", "text/html; charset=utf-8")).toBe(false);
    expect(mimeMatches("stylesheet", "text/css")).toBe(true);
    expect(mimeMatches("script", "application/javascript")).toBe(true);
    expect(mimeMatches("image", "image/avif")).toBe(true);
  });
});

describe("extended schema profiles", () => {
  const run = async (graph: unknown[]) => {
    const p = page(
      "/",
      "Product 49.99 2026-01-01",
      `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph })}</script>`,
    );
    return schemaRules(p, p.raw!);
  };
  it("distinguishes merchant eligibility from product snippet validity", async () => {
    const checks = await run([
      {
        "@type": "Product",
        name: "Product",
        offers: { "@type": "Offer", price: 0, priceCurrency: "USD" },
      },
    ]);
    expect(
      checks.find((c) => c.rule === "schema.google.MerchantListing.candidate"),
    ).toMatchObject({ severity: "info", outcome: "failed" });
    expect(
      checks.find((c) => c.rule === "schema.google.Product.offer-price")
        ?.outcome,
    ).toBe("passed");
  });
  it("finds conflicting group identifiers through normalized references", async () => {
    const checks = await run([
      {
        "@id": "#group",
        "@type": "ProductGroup",
        name: "T-shirt",
        productGroupID: "A",
        hasVariant: { "@id": "#p" },
      },
      {
        "@id": "#p",
        "@type": "Product",
        name: "Blue shirt",
        inProductGroupWithID: "B",
      },
    ]);
    expect(
      checks.find(
        (c) => c.rule === "schema.google.ProductGroup.identifier-consistency",
      )?.outcome,
    ).toBe("failed");
  });
  it("checks course and vacation-rental nested requirements", async () => {
    const checks = await run([
      { "@type": "Course", name: "Course" },
      {
        "@type": "VacationRental",
        name: "House",
        containsPlace: { "@type": "Accommodation" },
      },
    ]);
    expect(
      checks.some(
        (c) =>
          c.rule === "schema.google.Course.required" && c.outcome === "failed",
      ),
    ).toBe(true);
    for (const name of ["occupancy", "images", "coordinates"])
      expect(
        checks.some(
          (c) =>
            c.rule === "schema.google.VacationRental." + name &&
            c.outcome === "failed",
        ),
      ).toBe(true);
  });
  it("does not flag multilingual names and does not assert visible value semantics", async () => {
    const checks = await run([
      {
        "@id": "#p",
        "@type": "Product",
        name: [
          { "@value": "Name", "@language": "en" },
          { "@value": "Name DE", "@language": "de" },
        ],
        sku: ["a", "b"],
        offers: { "@type": "Offer", price: 49.99 },
      },
    ]);
    expect(
      checks.filter((c) => c.rule === "schema.entity-conflict"),
    ).toHaveLength(1);
    expect(
      checks.find((c) => c.rule === "schema.visible-values"),
    ).toMatchObject({
      outcome: "inconclusive",
      evidence: { literalFound: true },
    });
  });
});

describe("advanced browser integration", () => {
  it("checks mobile, bots, resource decoding, lazy content, soft404 and safe report gauges", async () => {
    const browser = await chromium.launch();
    const tab = await browser.newPage();
    const png = Buffer.from(
      await tab.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 1200;
        c.height = 630;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#214c71";
        ctx.fillRect(0, 0, 1200, 630);
        ctx.fillStyle = "white";
        ctx.font = "60px sans-serif";
        ctx.fillText("localseo · local preview", 80, 330);
        return c.toDataURL().split(",")[1];
      }),
      "base64",
    );
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url!, "http://localhost").pathname;
      requests.push(path);
      if (path === "/robots.txt") {
        res.setHeader("content-type", "text/plain");
        res.end("User-agent: *\nDisallow: /blocked.js");
        return;
      }
      if (path === "/sitemap.xml") {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (path === "/good.png") {
        res.setHeader("content-type", "image/png");
        res.end(png);
        return;
      }
      if (path === "/bad.png") {
        res.setHeader("content-type", "image/png");
        res.end("not an image");
        return;
      }
      if (path === "/document.pdf") {
        res.setHeader("content-type", "application/pdf");
        res.setHeader("x-robots-tag", "noindex");
        res.end("%PDF");
        return;
      }
      if (path === "/redirect.js") {
        res.statusCode = 302;
        res.setHeader("location", "/blocked.js");
        res.end();
        return;
      }
      res.setHeader("content-type", "text/html");
      const google = /Googlebot/.test(req.headers["user-agent"] ?? "");
      const mobile = /Android/.test(req.headers["user-agent"] ?? "");
      res.end(
        `<html><head><title>${mobile ? "Mobile title" : "Desktop title"}</title><meta name="description" content="A fixture"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8">${google ? '<meta name="robots" content="noindex">' : ""}<meta property="og:image" content="/good.png"><link rel="canonical" href="/"></head><body><main><h1>Useful local website</h1><p>Content about an interesting test fixture.</p><img src="/good.png" alt="Preview"><img src="/bad.png" alt="Broken"><a href="/document.pdf">Document</a><div style="height:1500px"></div></main><script src="/wrong.js"></script><script src="/blocked.js"></script><script src="/redirect.js"></script><script>addEventListener('scroll',()=>{if(!document.querySelector('#lazy'))document.querySelector('main').insertAdjacentHTML('beforeend','<p id="lazy">Extra text loaded after scrolling</p>')})</script></body></html>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    try {
      const r = await audit({
        url,
        maxPages: 1,
        advancedPages: 1,
        assetLimit: 20,
        settle: 20,
        timeout: 3000,
        probe404: true,
        output: "localseo-report/advanced-fixture",
      });
      for (const name of [
        "mobile.metadata",
        "render.resource-mime",
        "bots.google-response",
        "images.asset-decode",
        "render.lazy-content",
        "render.resources-robots",
      ])
        expect(
          r.checks.some((c) => c.rule === name && c.outcome === "failed"),
          name,
        ).toBe(true);
      expect(
        r.checks.filter((c) => c.rule === "http.rendered-unknown-route"),
      ).toHaveLength(2);
      expect(r.pages[0].socialPreviews?.[0]).toMatchObject({
        width: 1200,
        height: 630,
      });
      expect(
        r.checks.find((c) => c.rule === "robots.non-html")?.evidence,
      ).toMatchObject({ xRobotsTag: "noindex" });
      await writeReport(r);
      const errors: string[] = [];
      tab.on("pageerror", (e) => errors.push(e.message));
      for (const value of [0, 65, 100, null]) {
        r.score!.value = value;
        await tab.goto("about:blank");
        await tab.setContent(htmlReport(r));
        expect(
          await tab.locator(".score-gauge").getAttribute("aria-label"),
        ).toContain(value === null ? "unavailable" : String(value));
        expect(
          await tab.locator(".score-gauge path").nth(1).getAttribute("stroke"),
        ).toBe(
          value === null
            ? "#797d84"
            : value >= 90
              ? "#237747"
              : value >= 50
                ? "#a86b0b"
                : "#b63737",
        );
      }
      r.score = seoScore(r.checks, r.coverage.complete);
      await tab.goto("about:blank");
      await tab.setContent(htmlReport(r));
      await tab.locator("#pages-tab").click();
      await tab.locator("[data-page]").first().click();
      await expect
        .poll(() => tab.locator(".social-preview img").count())
        .toBe(1);
      expect(
        await tab
          .locator(".social-preview img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      ).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      await tab.setViewportSize({ width: 390, height: 844 });
      expect(
        await tab.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await tab.screenshot({
        path: "localseo-report/advanced-fixture/mobile.png",
        fullPage: true,
      });
      await tab.setViewportSize({ width: 1365, height: 900 });
      await tab.screenshot({
        path: "localseo-report/advanced-fixture/desktop.png",
        fullPage: true,
      });
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 45000);
});
