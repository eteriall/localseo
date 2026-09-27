import { chromium, type Browser } from "playwright";
import { Agent, fetch } from "undici";
import robotsParserImport from "robots-parser";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { extract } from "./extract.js";
import { localUrl, normalize, publicUrl } from "./url.js";
import { glob } from "./config.js";
import { check, docs } from "./check.js";
import type { Check, Options, Page } from "./types.js";
const robotsParser = robotsParserImport as unknown as (
  url: string,
  contents: string,
) => { isAllowed(url: string, userAgent: string): boolean | undefined };
export interface ResponseData {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  redirects: string[];
  error?: string;
  bytes?: Uint8Array;
  size?: number;
}
export class Http {
  private agent: Agent;
  constructor(private o: Options) {
    this.agent = new Agent({ connect: { rejectUnauthorized: !o.insecure } });
  }
  async get(
    input: string,
    canFetch?: (url: string) => boolean,
    captureBinary = false,
  ): Promise<ResponseData> {
    const redirects: string[] = [];
    let url = input;
    const signal = AbortSignal.timeout(this.o.timeout);
    try {
      for (let hops = 0; hops <= 10; hops++) {
        if (canFetch && !canFetch(url))
          throw new Error("Target excluded or disallowed by robots.txt");
        if (redirects.includes(url)) throw new Error("Redirect loop");
        const res = await fetch(url, {
          dispatcher: this.agent,
          redirect: "manual",
          signal,
          headers: { "user-agent": "localseo/0.1", ...this.o.headers },
        });
        const headers = Object.fromEntries(res.headers);
        if (
          [301, 302, 303, 307, 308].includes(res.status) &&
          headers.location
        ) {
          await res.body?.cancel();
          redirects.push(url);
          const next = localUrl(headers.location, this.o, url);
          if (!next)
            return {
              status: res.status,
              headers,
              body: "",
              finalUrl: url,
              redirects,
              error: "Redirect leaves configured crawl origin",
            };
          url = next;
          continue;
        }
        // Link/image checks need headers, not entire downloads. Keep HTML/XML/gzip bounded below.
        if (
          !captureBinary &&
          /^(?:image\/|audio\/|video\/|font\/|application\/(?:pdf|zip)\b)/i.test(
            headers["content-type"] ?? "",
          )
        ) {
          await res.body?.cancel();
          return {
            status: res.status,
            headers,
            body: "",
            finalUrl: url,
            redirects,
          };
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (res.body)
          for await (const chunk of res.body) {
            size += chunk.length;
            if (size > 8 * 1024 * 1024)
              throw new Error("Response exceeds 8 MiB limit");
            chunks.push(chunk);
          }
        const buffer = Buffer.concat(chunks);
        const decoded =
          buffer[0] === 0x1f && buffer[1] === 0x8b
            ? gunzipSync(buffer, { maxOutputLength: 8 * 1024 * 1024 })
            : buffer;
        return {
          status: res.status,
          headers,
          body: decoded.toString("utf8"),
          ...(captureBinary ? { bytes: decoded } : {}),
          size: decoded.length,
          finalUrl: url,
          redirects,
        };
      }
      throw new Error("More than 10 redirects");
    } catch (e) {
      return {
        status: 0,
        headers: {},
        body: "",
        finalUrl: url,
        redirects,
        error: (e as Error).message,
      };
    }
  }
  async close() {
    await this.agent.close();
  }
}
export interface CrawlResult {
  pages: Page[];
  checks: Check[];
  reasons: string[];
  sitemapUrls: string[];
  discovered: number;
  canFetch?: (url: string) => boolean;
  robotsAllowed?: (url: string) => boolean;
}
export async function crawl(
  o: Options,
  progress?: (message: string) => void,
): Promise<CrawlResult> {
  const http = new Http(o);
  let browser: Browser | undefined;
  const pages: Page[] = [],
    checks: Check[] = [],
    reasons = new Set<string>();
  const sitemapUrls = new Set<string>();
  let activeBrowsers = 0;
  const browserWaiters: (() => void)[] = [];
  const acquireBrowser = async () => {
    if (activeBrowsers >= o.browserConcurrency)
      await new Promise<void>((resolve) => browserWaiters.push(resolve));
    else activeBrowsers++;
  };
  const releaseBrowser = () => {
    const next = browserWaiters.shift();
    if (next) next();
    else activeBrowsers--;
  };
  const queued = new Map<string, { depth: number; sources: Set<string> }>();
  const done = new Set<string>();
  let robots = robotsParser(new URL("/robots.txt", o.url).href, "");
  const allowed = (u: string) =>
    o.ignoreRobots || robots.isAllowed(u, "Googlebot") !== false;
  const canFetch = (u: string) =>
    allowed(u) &&
    !o.exclude.some(
      (pattern) => glob(u, pattern) || glob(new URL(u).pathname, pattern),
    );
  const enqueue = (
    value: string,
    depth: number,
    source: string,
    explicit = false,
  ) => {
    const url = localUrl(value, o);
    if (
      !url ||
      o.exclude.some((p) => glob(url, p) || glob(new URL(url).pathname, p))
    )
      return;
    if (!explicit && !o.includeQuery && new URL(url).search) return;
    const old = queued.get(url);
    if (old) {
      old.sources.add(source);
      old.depth = Math.min(old.depth, depth);
      return;
    }
    if (depth > o.maxDepth) {
      reasons.add("Depth limit reached");
      return;
    }
    queued.set(url, { depth, sources: new Set([source]) });
  };
  enqueue(o.url, 0, "seed", true);
  for (const u of o.urls) enqueue(new URL(u, o.url).href, 0, "seed", true);
  try {
    if (o.render === "both") {
      try {
        browser = await chromium.launch({ headless: true });
      } catch {
        throw new Error(
          'Chromium is unavailable. Run "localseo setup" or explicitly choose "--render off".',
        );
      }
    }
    const robotsURL = new URL("/robots.txt", o.url).href;
    const rr = await http.get(robotsURL);
    checks.push(
      check(
        "robots.available",
        "Crawling",
        robotsURL,
        "info",
        rr.status === 200,
        "robots.txt availability",
        { status: rr.status, error: rr.error },
        "Provide robots.txt when crawl directives or sitemap declarations are needed.",
        docs + "crawling-indexing/robots/intro",
      ),
    );
    if (rr.error || rr.status >= 500 || rr.status === 429)
      reasons.add("robots.txt could not be evaluated reliably");
    const maps = [new URL("/sitemap.xml", o.url).href];
    if (rr.status === 200) {
      const invalid = rr.body
        .split(/\r?\n/)
        .filter(
          (l) =>
            l.trim() && !l.trim().startsWith("#") && !/^\s*[\w-]+\s*:/.test(l),
        );
      const html = /<html[\s>]/i.test(rr.body);
      checks.push(
        check(
          "robots.syntax",
          "Crawling",
          robotsURL,
          "warning",
          !invalid.length && !html,
          "robots.txt syntax",
          html ? "HTML received instead of robots.txt" : invalid,
          "Serve a plain-text robots.txt using valid directives.",
          docs + "crawling-indexing/robots/robots_txt",
        ),
      );
      if (!html) robots = robotsParser(robotsURL, rr.body);
      maps.push(
        ...rr.body
          .split(/\r?\n/)
          .flatMap((l) => /^\s*sitemap\s*:\s*(\S+)/i.exec(l)?.[1] ?? []),
      );
    }
    const seenMaps = new Set<string>();
    let validMaps = 0;
    while (maps.length) {
      const candidate = maps.shift()!;
      const mapURL = localUrl(candidate, o);
      if (!mapURL) {
        checks.push(
          check(
            "sitemap.external",
            "Crawling",
            o.url,
            "info",
            "inconclusive",
            "Sitemap outside crawl scope",
            candidate,
            "Supply a production-origin mapping or a local sitemap.",
          ),
        );
        continue;
      }
      if (seenMaps.has(mapURL)) continue;
      if (seenMaps.size >= 50) {
        reasons.add("Sitemap file limit reached (50)");
        break;
      }
      seenMaps.add(mapURL);
      const res = await http.get(mapURL);
      if (res.status === 404 && mapURL === new URL("/sitemap.xml", o.url).href)
        continue;
      const valid =
        res.status === 200 &&
        XMLValidator.validate(res.body) === true &&
        !/<!DOCTYPE|<!ENTITY/i.test(res.body);
      let parsed: any;
      if (valid)
        parsed = new XMLParser({
          removeNSPrefix: true,
          parseTagValue: false,
          processEntities: false,
        }).parse(res.body);
      const rootValid =
        valid &&
        (parsed?.urlset !== undefined || parsed?.sitemapindex !== undefined);
      checks.push(
        check(
          "sitemap.syntax",
          "Crawling",
          mapURL,
          "error",
          !!rootValid,
          "Sitemap XML and response validity",
          { status: res.status, error: res.error },
          "Serve a valid sitemap urlset or sitemapindex.",
          docs + "crawling-indexing/sitemaps/build-sitemap",
        ),
      );
      if (!rootValid) {
        reasons.add("A sitemap could not be read");
        continue;
      }
      validMaps++;
      const arr = (x: any): any[] =>
        x == null ? [] : Array.isArray(x) ? x : [x];
      for (const item of arr(parsed.sitemapindex?.sitemap))
        if (typeof item.loc === "string") maps.push(item.loc);
      for (const item of arr(parsed.urlset?.url)) {
        const loc =
          typeof item.loc === "string" ? normalize(item.loc) : undefined;
        checks.push(
          check(
            "sitemap.url",
            "Crawling",
            mapURL,
            "error",
            !!loc,
            "Sitemap entry must be an absolute HTTP(S) URL",
            item.loc,
            "Use absolute public URLs in sitemap loc elements.",
          ),
        );
        if (loc) {
          if (item.lastmod !== undefined) {
            const value = String(item.lastmod),
              stamp = Date.parse(value);
            checks.push(
              check(
                "sitemap.lastmod",
                "Crawling",
                mapURL,
                "warning",
                /^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(value) &&
                  Number.isFinite(stamp) &&
                  new Date(value.slice(0, 10)).toISOString().slice(0, 10) ===
                    value.slice(0, 10) &&
                  stamp <= Date.now() + 86400000,
                "Sitemap lastmod validity",
                { url: loc, lastmod: value },
                "Use a valid modification date, not a future date. Content freshness itself requires manual verification.",
              ),
            );
          }
          const local = localUrl(loc, o);
          if (local) {
            if (sitemapUrls.has(local))
              checks.push(
                check(
                  "sitemap.duplicate",
                  "Crawling",
                  mapURL,
                  "info",
                  false,
                  "Repeated sitemap URL",
                  loc,
                  "Avoid repeated entries across discovered sitemaps.",
                ),
              );
            sitemapUrls.add(local);
            enqueue(local, 0, "sitemap", true);
          } else
            checks.push(
              check(
                "sitemap.scope",
                "Crawling",
                mapURL,
                "warning",
                "inconclusive",
                "Sitemap URL outside crawl scope",
                loc,
                "Configure the intended production origin.",
              ),
            );
        }
      }
    }
    checks.push(
      check(
        "sitemap.available",
        "Crawling",
        o.url,
        "info",
        validMaps > 0,
        "Sitemap discovery",
        { validMaps },
        "Provide a sitemap to improve route coverage.",
      ),
    );
    const scan = async ([url, task]: [
      string,
      { depth: number; sources: Set<string> },
    ]) => {
      const page: Page = {
        url,
        publicUrl: publicUrl(url, o),
        depth: task.depth,
        discoveredBy: [],
        status: 0,
        finalUrl: url,
        redirects: [],
        headers: {},
        consoleErrors: [],
        resourceFailures: [],
        robotsDisallowed: robots.isAllowed(url, "Googlebot") === false,
      };
      if (!allowed(url)) {
        page.blocked = true;
        pages.push(page);
        return;
      }
      progress?.(`Scanning ${url}`);
      const res = await http.get(url, canFetch);
      Object.assign(page, {
        status: res.status,
        finalUrl: res.finalUrl,
        redirects: res.redirects,
        headers: res.headers,
        error: res.error,
      });
      if (res.error) reasons.add("One or more page requests failed");
      if (
        /\b(text\/html|application\/xhtml\+xml)\b/i.test(
          res.headers["content-type"] ?? "",
        )
      ) {
        page.raw = extract(res.body, res.finalUrl);
        const linkHeader = res.headers.link;
        if (linkHeader)
          for (const match of linkHeader.matchAll(
            /<([^>]+)>\s*;\s*rel=["']?canonical["']?/gi,
          ))
            page.raw.canonicals.push(new URL(match[1], res.finalUrl).href);
        if (browser) {
          await acquireBrowser();
          try {
            const context = await browser.newContext({
              ignoreHTTPSErrors: o.insecure,
              extraHTTPHeaders: o.headers,
            });
            let collectingResources = true;
            try {
              await context.route("**/*", async (route) => {
                const request = route.request();
                if (request.isNavigationRequest()) {
                  const mapped = localUrl(request.url(), o);
                  if (!mapped || !canFetch(mapped)) {
                    await route.abort("blockedbyclient");
                    return;
                  }
                  if (mapped !== request.url()) {
                    await route.continue({ url: mapped });
                    return;
                  }
                }
                // Never forward custom authentication headers to third-party resources.
                if (new URL(request.url()).origin !== new URL(o.url).origin) {
                  const headers = { ...request.headers() };
                  for (const k of Object.keys(o.headers))
                    delete headers[k.toLowerCase()];
                  await route.continue({ headers });
                  return;
                }
                await route.continue();
              });
              const tab = await context.newPage();
              tab.on("pageerror", (e) => page.consoleErrors.push(e.message));
              tab.on("response", (response) => {
                const request = response.request();
                if (
                  collectingResources &&
                  response.status() >= 400 &&
                  !request.isNavigationRequest()
                )
                  page.resourceFailures!.push({
                    url: response.url(),
                    type: request.resourceType(),
                    status: response.status(),
                  });
              });
              tab.on("requestfailed", (request) => {
                // Browser/app cancellation and audit teardown are not failed resources.
                if (
                  collectingResources &&
                  !request.isNavigationRequest() &&
                  request.failure()?.errorText !== "net::ERR_ABORTED"
                )
                  page.resourceFailures!.push({
                    url: request.url(),
                    type: request.resourceType(),
                    error: request.failure()?.errorText,
                  });
              });
              await tab.goto(url, { waitUntil: "load", timeout: o.timeout });
              if (o.waitSelector)
                await tab.waitForSelector(o.waitSelector, {
                  timeout: o.timeout,
                });
              // Wait for semantic DOM stability, bounded independently of ongoing animations/network traffic.
              const settleDeadline =
                Date.now() + Math.min(o.timeout, Math.max(5000, o.settle * 2));
              for (;;) {
                try {
                  page.renderSettled = await tab.evaluate(
                    async ({ quiet, budget }) => {
                      if (!quiet) return true;
                      const started = Date.now();
                      let changed = started;
                      let previous = "";
                      while (Date.now() - started < budget) {
                        const current = JSON.stringify([
                          document.title,
                          document.body?.innerText,
                          [
                            ...document.querySelectorAll(
                              'meta,link[rel="canonical"],a[href],script[type="application/ld+json"]',
                            ),
                          ].map((e) => [
                            e.getAttribute("content"),
                            e.getAttribute("href"),
                            e.textContent,
                          ]),
                        ]);
                        if (current !== previous) {
                          previous = current;
                          changed = Date.now();
                        }
                        if (Date.now() - changed >= quiet) return true;
                        await new Promise((resolve) =>
                          setTimeout(resolve, Math.min(100, quiet)),
                        );
                      }
                      return false;
                    },
                    {
                      quiet: o.settle,
                      budget: Math.max(0, settleDeadline - Date.now()),
                    },
                  );
                  if (!page.renderSettled)
                    reasons.add(
                      "One or more rendered pages did not stabilize within the wait budget",
                    );
                  page.rendered = extract(await tab.content(), tab.url());
                  break;
                } catch (error) {
                  const remaining = settleDeadline - Date.now();
                  if (
                    !/Execution context was destroyed|Cannot find context|page is navigating/i.test(
                      (error as Error).message,
                    ) ||
                    remaining <= 0
                  )
                    throw error;
                  await tab.waitForLoadState("domcontentloaded", {
                    timeout: remaining,
                  });
                }
              }
              if (linkHeader)
                for (const match of linkHeader.matchAll(
                  /<([^>]+)>\s*;\s*rel=["']?canonical["']?/gi,
                ))
                  page.rendered.canonicals.push(
                    new URL(match[1], res.finalUrl).href,
                  );
            } catch (e) {
              page.renderError = (e as Error).message;
              reasons.add("One or more pages could not be rendered");
            } finally {
              collectingResources = false;
              await context.close();
            }
          } finally {
            releaseBrowser();
          }
        }
        for (const snapshot of [page.raw, page.rendered])
          if (snapshot) {
            for (const link of snapshot.links)
              enqueue(link, task.depth + 1, url);
            for (const target of [
              ...snapshot.canonicals,
              ...snapshot.hreflang.map((h) => h.href),
            ])
              enqueue(target, task.depth + 1, "validation:" + url);
          }
      }
      pages.push(page);
    };
    while (true) {
      const pending = [...queued].filter(([u]) => !done.has(u));
      if (!pending.length) break;
      if (done.size >= o.maxPages) {
        reasons.add("Page limit reached");
        break;
      }
      const batch = pending.slice(
        0,
        Math.min(o.concurrency, o.maxPages - done.size),
      );
      batch.forEach(([u]) => done.add(u));
      await Promise.all(batch.map(scan));
    }
    for (const page of pages)
      page.discoveredBy = [...queued.get(page.url)!.sources].sort();
    if (o.probe404) {
      const url = new URL(`/localseo-missing-${randomUUID()}`, o.url).href;
      const r = await http.get(url, canFetch);
      const snapshot = /html/i.test(r.headers["content-type"] ?? "")
        ? extract(r.body, r.finalUrl)
        : undefined;
      const noindex =
        snapshot?.robots.some((v) => /\b(?:noindex|none)\b/i.test(v)) ||
        /\b(?:noindex|none)\b/i.test(r.headers["x-robots-tag"] ?? "");
      const c = check(
        "http.unknown-route",
        "HTTP",
        o.url,
        "warning",
        r.error
          ? "inconclusive"
          : [404, 410].includes(r.status) || !!noindex
            ? true
            : "inconclusive",
        "Unknown-route response / soft-404 risk",
        {
          probe: url,
          status: r.status,
          redirects: r.redirects,
          finalUrl: r.finalUrl,
          title: snapshot?.titles,
          noindex: !!noindex,
          error: r.error,
        },
        "Unknown paths should return 404/410 or an intentional noindex error view. A 200 shell or redirect needs rendered/manual review; it is not proof of a soft 404.",
        docs + "crawling-indexing/javascript/javascript-seo-basics",
      );
      c.confidence = c.outcome === "passed" ? "observed" : "unverified";
      checks.push(c);
    }
    return {
      pages: pages.sort((a, b) => a.url.localeCompare(b.url)),
      checks,
      reasons: [...reasons],
      sitemapUrls: [...sitemapUrls].sort(),
      discovered: queued.size,
      canFetch,
      robotsAllowed: (u) => robots.isAllowed(u, "Googlebot") !== false,
    };
  } finally {
    await browser?.close();
    await http.close();
  }
}
