import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { audit as fullAudit } from "../src/index.js";
const audit = (input: Parameters<typeof fullAudit>[0]) =>
  fullAudit({ ...input, advanced: false });
import { htmlReport } from "../src/report.js";
import { fixture } from "./fixtures.js";
describe("Chromium integration", () => {
  it("survives client navigation during settling and ignores cancelled fetches", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin + "/client-redirect",
        urls: ["/cancelled-fetch"],
        maxPages: 2,
        settle: 300,
      });
      const p = r.pages.find((p) => p.url.endsWith("/client-redirect"))!;
      expect(p.renderError).toBeUndefined();
      expect(p.rendered?.text).toContain("/static");
      expect(
        r.pages.find((p) => p.url.endsWith("/cancelled-fetch"))
          ?.resourceFailures,
      ).toEqual([]);
    } finally {
      await site.close();
    }
  }, 15000);
  it("waits for semantic stability and records broken browser resources", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin + "/delayed",
        urls: ["/resources"],
        maxPages: 2,
        settle: 300,
      });
      expect(
        r.pages.find((p) => p.url.endsWith("/delayed"))?.rendered?.titles,
      ).toContain("Settled title");
      expect(
        r.pages.find((p) => p.url.endsWith("/delayed"))?.renderSettled,
      ).toBe(true);
      expect(
        r.checks.find(
          (c) => c.url.endsWith("/resources") && c.rule === "render.resources",
        )?.outcome,
      ).toBe("failed");
    } finally {
      await site.close();
    }
  }, 15000);
  it("discovers JS-only pages and shows an interactive, escaped, responsive report", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin,
        exclude: ["/loop-*"],
        settle: 10,
      });
      expect(r.pages.some((p) => p.url.endsWith("/js-only"))).toBe(true);
      expect(
        r.checks.some(
          (c) => c.rule === "render.content" && c.outcome === "failed",
        ),
      ).toBe(true);
      expect(r.coverage.complete).toBe(true);
      r.checks.push({
        ...r.checks[0],
        url: '<img src=x onerror="window.pwned=1">',
        message: "</script><script>window.pwned=1</script>",
        outcome: "failed",
      });
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.setContent(htmlReport(r));
        expect(await page.locator(".metric").count()).toBe(4);
        expect(await page.locator(".group").count()).toBeGreaterThan(0);
        await page.locator("#outcome").selectOption("review");
        await page.locator("#search").fill("render.content");
        expect(await page.locator(".group").count()).toBe(1);
        await page.locator(".group summary").click();
        expect(await page.locator(".finding").count()).toBeGreaterThan(0);
        expect(
          await page.evaluate(() => Reflect.get(window, "pwned")),
        ).toBeUndefined();
        expect(errors).toEqual([]);
        await page.locator("#pages-tab").click();
        await page.locator("#page-search").fill("/client");
        expect(await page.locator("#pages tr").count()).toBe(1);
        await page.locator("[data-page]").click();
        expect(await page.locator("#inspector").isVisible()).toBe(true);
        expect(await page.locator("#inspector").textContent()).toContain(
          "Rendered title",
        );
        await page.locator("#run-tab").click();
        expect(await page.locator("#run-data").isVisible()).toBe(true);
        await page.locator("#issues-tab").click();
        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      } finally {
        await browser.close();
      }
    } finally {
      await site.close();
    }
  }, 30000);
  it("retains raw evidence when browser wait conditions fail", async () => {
    const site = await fixture();
    try {
      const r = await audit({
        url: site.origin + "/stream",
        maxPages: 1,
        waitSelector: "#does-not-exist",
        timeout: 200,
        settle: 0,
      });
      expect(r.pages[0].raw).toBeDefined();
      expect(r.coverage.complete).toBe(false);
    } finally {
      await site.close();
    }
  }, 15000);
});
