import { chromium } from "playwright";
import { localUrl } from "./url.js";
import type { Options, Page, Report } from "./types.js";
export async function performance(
  pages: Page[],
  o: Options,
): Promise<Report["lighthouse"]> {
  if (!o.lighthouse) return [];
  const candidates = pages
    .filter((p) => p.status === 200 && p.raw && !p.error && !p.blocked)
    .map((p) => p.url);
  const urls = o.lighthouseUrls.length
    ? o.lighthouseUrls
        .map((u) => localUrl(u, o))
        .filter((u): u is string => !!u)
    : candidates.sort((a, b) =>
        a === o.url ? -1 : b === o.url ? 1 : a.localeCompare(b),
      );
  const results: Report["lighthouse"] = [];
  try {
    const [{ default: lighthouse }, { launch }, { connect }] =
      await Promise.all([
        import("lighthouse"),
        import("chrome-launcher"),
        import("puppeteer-core"),
      ]);
    const chrome = await launch({
      chromePath: chromium.executablePath(),
      chromeFlags: [
        "--headless",
        ...(o.insecure ? ["--ignore-certificate-errors"] : []),
      ],
    });
    const browser = await connect({
      browserURL: `http://127.0.0.1:${chrome.port}`,
    });
    try {
      for (const url of [...new Set(urls)].slice(0, o.lighthousePages)) {
        if (!candidates.includes(url)) {
          results.push({
            url,
            error: "URL was not successfully crawled; Lighthouse skipped",
          });
          continue;
        }
        try {
          const page = await browser.newPage();
          await page.setRequestInterception(true);
          page.on("request", (request) => {
            if (request.isInterceptResolutionHandled()) return;
            const mapped = localUrl(request.url(), o);
            if (request.isNavigationRequest() && !mapped) {
              void request.abort();
              return;
            }
            const local =
              new URL(request.url()).origin === new URL(o.url).origin;
            void request.continue({
              ...(request.isNavigationRequest() && mapped
                ? { url: mapped }
                : {}),
              headers: { ...request.headers(), ...(local ? o.headers : {}) },
            });
          });
          let result;
          try {
            result = await lighthouse(
              url,
              {
                port: chrome.port,
                output: "json",
                onlyCategories: ["performance"],
                maxWaitForLoad: o.timeout,
              },
              undefined,
              page,
            );
          } finally {
            await page.close();
          }
          if (!result) throw new Error("Lighthouse returned no result");
          if (result.lhr.runtimeError)
            throw new Error(result.lhr.runtimeError.message);
          results.push({
            url,
            scores: Object.fromEntries(
              Object.entries(result.lhr.categories).map(([k, v]) => [
                k,
                v.score,
              ]),
            ),
            metrics: Object.fromEntries(
              [
                "first-contentful-paint",
                "largest-contentful-paint",
                "total-blocking-time",
                "cumulative-layout-shift",
                "speed-index",
              ].map((k) => [
                k,
                {
                  value: result.lhr.audits[k]?.numericValue,
                  unit: result.lhr.audits[k]?.numericUnit,
                },
              ]),
            ),
          });
        } catch (e) {
          results.push({ url, error: (e as Error).message });
        }
      }
    } finally {
      await browser.disconnect();
      await chrome.kill();
    }
  } catch (e) {
    results.push({
      url: o.url,
      error: `Lighthouse unavailable: ${(e as Error).message}`,
    });
  }
  return results;
}
