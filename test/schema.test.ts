import { describe, it, expect } from "vitest";
import { schemaRules, profiles } from "../src/schema.js";
import { extract } from "../src/extract.js";
import { html } from "./fixtures.js";
import type { Page } from "../src/types.js";
const page = {
  url: "http://localhost/",
  publicUrl: "https://example.org/",
} as Page;
const run = (value: any) =>
  schemaRules(
    page,
    extract(
      html(
        "<p>Example title Example Author</p>",
        `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", ...value })}</script>`,
      ),
      page.url,
    ),
  );
describe("structured data", () => {
  it("rejects boolean integers, invalid times and out-of-order durations", async () => {
    const checks = await run({
      "@graph": [
        { "@type": "ListItem", position: true },
        { "@type": "OpeningHoursSpecification", opens: "99:99garbage" },
        { "@type": "VideoObject", duration: "PT1S2H" },
      ],
    });
    for (const prop of ["position", "opens"])
      expect(
        checks.some(
          (c) =>
            c.rule === "schema.property-range" &&
            c.outcome === "failed" &&
            (c.evidence as any).prop === prop,
        ),
      ).toBe(true);
    expect(
      checks.some(
        (c) => c.rule === "schema.duration" && c.outcome === "failed",
      ),
    ).toBe(true);
  });
  it("checks vocabulary, nested range, dates and references", async () => {
    const checks = await run({
      "@type": "Article",
      headline: "Example title",
      datePublished: "2026-02-30",
      author: { "@type": "Person", name: "Example Author" },
      madeUpField: 1,
      publisher: { "@id": "#missing" },
    });
    expect(
      checks.some(
        (c) => c.rule === "schema.property-known" && c.outcome === "failed",
      ),
    ).toBe(true);
    expect(
      checks.some((c) => c.rule === "schema.date" && c.outcome === "failed"),
    ).toBe(true);
    expect(
      checks.some(
        (c) => c.rule === "schema.reference" && c.outcome === "failed",
      ),
    ).toBe(true);
    expect(
      checks.some(
        (c) =>
          c.rule === "schema.google.Article.required" && c.outcome === "failed",
      ),
    ).toBe(false);
    expect(
      checks.some(
        (c) =>
          c.rule === "schema.property-range" &&
          c.outcome === "failed" &&
          JSON.stringify(c.evidence).includes("author"),
      ),
    ).toBe(false);
  });
  it("resolves graph references and recognizes inherited types", async () => {
    const checks = await run({
      "@graph": [
        {
          "@id": "#a",
          "@type": "BlogPosting",
          headline: "Example title",
          author: { "@id": "#person" },
        },
        { "@id": "#person", "@type": "Person", name: "Example Author" },
      ],
    });
    expect(checks.some((c) => c.rule === "schema.google.Article.manual")).toBe(
      true,
    );
    expect(
      checks.some(
        (c) => c.rule === "schema.reference" && c.outcome === "failed",
      ),
    ).toBe(false);
  });
  it("does not fetch unknown contexts or pretend unsupported types passed", async () => {
    const s = extract(
      html(
        "",
        '<script type="application/ld+json">{"@context":"https://unknown.invalid/context","@type":"Thing"}</script>',
      ),
      page.url,
    );
    const checks = await schemaRules(page, s);
    expect(checks.some((c) => c.outcome === "inconclusive")).toBe(true);
    expect(
      (await run({ "@type": "Movie", name: "Example" })).some(
        (c) =>
          c.rule === "schema.google-coverage" && c.outcome === "inconclusive",
      ),
    ).toBe(true);
  });
  it("marks FAQ Google eligibility retired rather than passing it", async () => {
    const c = await run({ "@type": "FAQPage" });
    expect(
      c.some(
        (c) => c.message.includes("retired") && c.outcome === "inconclusive",
      ),
    ).toBe(true);
  });
  it.each(Object.keys(profiles))("evaluates the %s profile", async (type) => {
    const checks = await run({ "@type": type });
    expect(
      checks.some((c) => c.rule.startsWith(`schema.google.${type}.`)),
    ).toBe(true);
    for (const field of profiles[type].required)
      expect(
        checks.some(
          (c) =>
            c.rule === `schema.google.${type}.required` &&
            c.outcome === "failed" &&
            (c.evidence as any).field === field,
        ),
      ).toBe(true);
  });
  it("validates Product alternatives and nested offer prices", async () => {
    const c = await run({
      "@type": "Product",
      name: "Example",
      offers: { "@type": "Offer", price: "-1", priceCurrency: "euros" },
    });
    expect(
      c.some((c) => c.rule === "schema.price" && c.outcome === "failed"),
    ).toBe(true);
    expect(
      c.some((c) => c.rule === "schema.currency" && c.outcome === "failed"),
    ).toBe(true);
    expect(
      (await run({ "@type": "Product", name: "Example" })).some(
        (c) =>
          c.rule === "schema.google.Product.alternatives" &&
          c.outcome === "failed",
      ),
    ).toBe(true);
  });
  it("validates breadcrumb ordering and last-item exception", async () => {
    const c = await run({
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: "https://example.org/",
        },
        { "@type": "ListItem", position: 2, name: "Example" },
      ],
    });
    expect(
      c.filter(
        (c) => c.rule === "schema.property-range" && c.outcome === "failed",
      ),
    ).toEqual([]);
    expect(
      c.filter(
        (c) =>
          c.rule.startsWith("schema.google.BreadcrumbList") &&
          c.outcome === "failed",
      ),
    ).toEqual([]);
  });
  it("checks remote jobs, recipe calories, ratings and chronology", async () => {
    const c = await run({
      "@graph": [
        { "@type": "JobPosting", jobLocationType: "TELECOMMUTE" },
        {
          "@type": "Recipe",
          nutrition: {
            "@type": "NutritionInformation",
            calories: "20 calories",
          },
        },
        { "@type": "AggregateRating", ratingValue: 8 },
        { "@type": "Event", startDate: "2026-09-02", endDate: "2026-09-01" },
      ],
    });
    for (const id of [
      "schema.google.JobPosting.required",
      "schema.google.Recipe.yield",
      "schema.rating",
      "schema.date-order",
    ])
      expect(c.some((c) => c.rule === id && c.outcome === "failed")).toBe(true);
  });
  it.each(["microdata", "rdfa"])(
    "normalizes %s and validates the same profiles",
    async (format) => {
      const markup =
        format === "microdata"
          ? '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Example</span></div>'
          : '<div vocab="https://schema.org/" typeof="Product"><span property="name">Example</span></div>';
      const c = await schemaRules(page, extract(html(markup), page.url));
      expect(
        c.some(
          (c) =>
            c.rule === "schema.google.Product.alternatives" &&
            c.outcome === "failed",
        ),
      ).toBe(true);
      expect(
        c.some((c) => c.rule === "schema.syntax" && c.outcome === "failed"),
      ).toBe(false);
    },
  );
});
