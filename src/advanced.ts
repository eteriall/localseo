import { chromium, type Browser, type Page as BrowserPage } from "playwright";
import { randomUUID } from "node:crypto";
import { Http, type CrawlResult } from "./crawl.js";
import { check, docs } from "./check.js";
import { extract } from "./extract.js";
import { localUrl } from "./url.js";
import { semanticJson, directiveValues } from "./rules.js";
import { similarity } from "./site-rules.js";
import type { Check, Options, Page, Snapshot } from "./types.js";

export const mimeMatches = (type: string, mime: string) => {
  mime = mime.split(";")[0].trim().toLowerCase();
  if (type === "script")
    return /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/.test(
      mime,
    );
  if (type === "stylesheet") return mime === "text/css";
  if (type === "pdf") return mime === "application/pdf";
  if (type === "embed")
    return ["text/html", "application/xhtml+xml"].includes(mime);
  if (type === "image" || type === "social") return mime.startsWith("image/");
  if (type === "video")
    return mime.startsWith("video/") || /(?:mpegurl|dash\+xml)/.test(mime);
  return true;
};
const botAgents = {
  Googlebot:
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  Twitterbot: "Twitterbot/1.0",
  Facebook:
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
};
const json = (s: Snapshot) =>
  s.structured
    .filter((b) => b.format === "jsonld")
    .map((b) => semanticJson(b.value))
    .sort();
const sorted = (items: string[]) => [...new Set(items)].sort();
const metadata = (s: Snapshot) => ({
  title: s.titles,
  description: s.descriptions,
  canonical: s.canonicals,
  robots: s.robots,
});
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export async function advancedRules(
  result: CrawlResult,
  o: Options,
  progress?: (s: string) => void,
): Promise<Check[]> {
  const checks: Check[] = [],
    pages = result.pages.filter((p) => p.status === 200 && p.raw);
  const emit = (
    rule: string,
    url: string,
    valid: boolean | "inconclusive" | "skipped",
    message: string,
    evidence: unknown,
    heuristic = false,
  ) =>
    checks.push({
      ...check(
        rule,
        rule.startsWith("social.")
          ? "Sharing"
          : rule.startsWith("images.")
            ? "Images"
            : rule.startsWith("video.")
              ? "Video"
              : rule.startsWith("robots.")
                ? "Indexing"
                : "Rendering",
        url,
        rule.startsWith("social.") || heuristic ? "info" : "warning",
        valid,
        message,
        evidence,
        "Review the recorded response and affected element. Keep essential content and metadata available to crawlers without interaction; serve resources with the correct HTTP status and Content-Type.",
        docs + "crawling-indexing/javascript/javascript-seo-basics",
      ),
      confidence: heuristic
        ? ("heuristic" as const)
        : valid === "inconclusive"
          ? ("unverified" as const)
          : ("observed" as const),
    });
  if (!o.advanced) {
    emit(
      "advanced.coverage",
      o.url,
      "skipped",
      "Advanced probes disabled",
      null,
    );
    return checks;
  }
  const canFetch = result.canFetch ?? (() => true);
  const http = new Http(o);
  let browser: Browser | undefined, decoder: BrowserPage | undefined;
  const assets = new Map<string, { type: string; pages: Set<Page> }>();
  const addAsset = (value: string, type: string, p: Page) => {
    const url = localUrl(value, o, p.url);
    if (!url) {
      if (/^https?:/.test(value))
        emit(
          "resources.external",
          p.url,
          "inconclusive",
          "External resource not fetched by additional probes",
          { url: value, type },
        );
      return;
    }
    const key = `${type}:${url}`;
    if (!assets.has(key)) assets.set(key, { type, pages: new Set() });
    assets.get(key)!.pages.add(p);
  };
  for (const p of pages) {
    const s = p.rendered ?? p.raw!;
    for (const r of s.technical?.resources ?? []) addAsset(r.url, r.type, p);
    for (const r of [
      ...(p.raw?.technical?.schemaMedia ?? []),
      ...(p.rendered?.technical?.schemaMedia ?? []),
    ])
      addAsset(r.url, r.type, p);
    for (const value of [
      s.social["og:image"],
      s.social["twitter:image"],
    ].filter(Boolean))
      addAsset(value, "social", p);
    for (const url of s.links.filter((u) => /\.pdf(?:[?#]|$)/i.test(u)))
      addAsset(url, "pdf", p);
  }
  const candidates = pages.slice(0, o.advancedPages);
  try {
    if (o.render === "both") {
      try {
        browser = await chromium.launch({ headless: true });
        decoder = await browser.newPage();
      } catch (e) {
        emit(
          "advanced.browser",
          o.url,
          "inconclusive",
          "Advanced browser could not start",
          String(e),
        );
      }
    }
    const probe = async (url: string, mobile: boolean, scroll = false) => {
      if (!browser)
        throw new Error("Rendering is disabled or browser is unavailable");
      const context = await browser.newContext({
        ignoreHTTPSErrors: o.insecure,
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1365, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
        extraHTTPHeaders: o.headers,
        serviceWorkers: "block",
        ...(mobile
          ? {
              userAgent:
                "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
            }
          : {}),
      });
      const tab = await context.newPage();
      const mimeFailures: unknown[] = [],
        blocked: string[] = [],
        externalDependencies: string[] = [];
      await context.route("**/*", async (route) => {
        const req = route.request(),
          mapped = localUrl(req.url(), o);
        if (!mapped || !canFetch(mapped)) {
          if (
            !mapped &&
            ["script", "stylesheet", "fetch", "xhr"].includes(
              req.resourceType(),
            )
          )
            externalDependencies.push(req.url());
          if (mapped && result.robotsAllowed?.(mapped) === false)
            blocked.push(mapped);
          await route.abort();
          return;
        }
        if (result.robotsAllowed?.(mapped) === false) blocked.push(mapped);
        await route.continue({ url: mapped });
      });
      tab.on("response", (response) => {
        const type = response.request().resourceType(),
          mime = response.headers()["content-type"] ?? "";
        if (
          ["script", "stylesheet", "image"].includes(type) &&
          response.status() >= 200 &&
          response.status() < 300 &&
          !mimeMatches(type, mime)
        )
          mimeFailures.push({
            url: response.url(),
            type,
            mime,
            status: response.status(),
          });
      });
      try {
        const response = await tab.goto(url, {
          waitUntil: "load",
          timeout: o.timeout,
        });
        if (o.waitSelector)
          await tab.waitForSelector(o.waitSelector, { timeout: o.timeout });
        await tab.waitForTimeout(Math.min(o.settle, 2000));
        const before = extract(await tab.content(), tab.url());
        const visible = await tab.locator("body").innerText();
        if (scroll) {
          for (let i = 0; i < 6; i++) {
            await tab.evaluate(() => window.scrollBy(0, window.innerHeight));
            await tab.waitForTimeout(100);
          }
        }
        const after = extract(await tab.content(), tab.url());
        const runtime = await tab.evaluate(() => ({
          images: [...document.images].map((img) => ({
            src: img.currentSrc || img.src,
            width: img.naturalWidth,
            height: img.naturalHeight,
            complete: img.complete,
            loading: img.loading,
            renderedWidth: img.getBoundingClientRect().width,
          })),
          backgrounds: [...document.querySelectorAll("body *")]
            .slice(0, 2000)
            .flatMap((e) =>
              [
                ...getComputedStyle(e).backgroundImage.matchAll(
                  /url\(["']?([^"')]+)["']?\)/g,
                ),
              ].map((m) => m[1]),
            ),
          controls: [...document.querySelectorAll("button,[role=button]")]
            .map((e) => e.textContent?.trim())
            .filter(
              (t) => t && /load more|show more|показать|загрузить/i.test(t),
            )
            .slice(0, 20),
          videos: [...document.querySelectorAll("video")].map((v) => ({
            src: v.currentSrc || v.src,
            readyState: v.readyState,
            error: v.error?.message,
            poster: v.poster,
          })),
        }));
        return {
          before,
          after,
          visible,
          runtime,
          mimeFailures,
          blocked: sorted(blocked),
          externalDependencies: sorted(externalDependencies),
          status: response?.status(),
          headers: response?.headers() ?? {},
        };
      } finally {
        await context.close();
      }
    };
    for (const [i, p] of candidates.entries()) {
      progress?.(`Advanced checks ${i + 1}/${candidates.length}: ${p.url}`);
      if (browser) {
        try {
          const desktop = await probe(p.url, false, true),
            mobile = await probe(p.url, true);
          emit(
            "render.resource-mime",
            p.url,
            !desktop.mimeFailures.length && !mobile.mimeFailures.length,
            "Browser resources returned incorrect MIME types",
            { desktop: desktop.mimeFailures, mobile: mobile.mimeFailures },
          );
          emit(
            "render.resources-robots",
            p.url,
            !desktop.blocked.length && !mobile.blocked.length,
            "Resources disallowed for Googlebot",
            { desktop: desktop.blocked, mobile: mobile.blocked },
          );
          const md = metadata(desktop.before),
            mm = metadata(mobile.before);
          const unavailable = sorted([
            ...desktop.externalDependencies,
            ...mobile.externalDependencies,
          ]);
          emit(
            "mobile.metadata",
            p.url,
            unavailable.length
              ? "inconclusive"
              : JSON.stringify(md) === JSON.stringify(mm),
            "Mobile and desktop metadata parity",
            {
              desktop: md,
              mobile: mm,
              externalDependenciesNotLoaded: unavailable,
            },
          );
          emit(
            "mobile.status",
            p.url,
            desktop.status === mobile.status && mobile.status === 200,
            "Mobile and desktop HTTP status parity",
            { desktop: desktop.status, mobile: mobile.status },
          );
          const desktopText = norm(
              desktop.before.mainText ?? desktop.before.text,
            ),
            mobileText = norm(mobile.before.mainText ?? mobile.before.text);
          emit(
            "mobile.content",
            p.url,
            desktopText === mobileText ||
              similarity(desktopText, mobileText) >= 0.9,
            "Mobile and desktop main-content parity",
            {
              desktopCharacters: desktopText.length,
              mobileCharacters: mobileText.length,
              similarity: similarity(desktopText, mobileText),
              note: "Responsive navigation differences and dynamic content require review.",
            },
            true,
          );
          emit(
            "mobile.links",
            p.url,
            JSON.stringify(sorted(desktop.before.links)) ===
              JSON.stringify(sorted(mobile.before.links)),
            "Mobile and desktop link parity",
            {
              absentOnMobile: desktop.before.links
                .filter((u) => !mobile.before.links.includes(u))
                .slice(0, 50),
            },
            true,
          );
          emit(
            "mobile.schema",
            p.url,
            unavailable.length
              ? "inconclusive"
              : JSON.stringify(json(desktop.before)) ===
                  JSON.stringify(json(mobile.before)),
            "Mobile and desktop JSON-LD parity",
            {
              desktop: json(desktop.before),
              mobile: json(mobile.before),
              externalDependenciesNotLoaded: unavailable,
              note: "Microdata/RDFa are validated separately; parity here covers JSON-LD.",
            },
          );
          const newLinks = desktop.after.links.filter(
            (u) => !desktop.before.links.includes(u),
          );
          emit(
            "render.lazy-content",
            p.url,
            norm(desktop.before.mainText ?? "") ===
              norm(desktop.after.mainText ?? "") && !newLinks.length,
            "Content appeared only after scrolling",
            {
              beforeCharacters: desktop.before.mainText?.length,
              afterCharacters: desktop.after.mainText?.length,
              newLinks: newLinks.slice(0, 50),
              scrollSteps: 6,
              note: "Existing collapsed DOM content is not treated as missing. Bounded scroll cannot prove all content is discovered.",
            },
            true,
          );
          if (desktop.runtime.controls.length)
            emit(
              "pagination.interaction",
              p.url,
              "inconclusive",
              "Load-more controls need crawlable URL alternatives",
              {
                controls: desktop.runtime.controls,
                pagination: desktop.after.technical?.pagination,
                note: "Controls are not clicked; infinite content completeness is not automatically provable.",
              },
              true,
            );
          const brokenImages = desktop.runtime.images.filter(
            (img) =>
              img.complete &&
              !img.width &&
              img.src &&
              !!localUrl(img.src, o) &&
              canFetch(localUrl(img.src, o)!),
          );
          emit(
            "images.browser-decode",
            p.url,
            !brokenImages.length,
            "Browser image decoding",
            brokenImages,
          );
          const pending = desktop.runtime.images.filter((img) => !img.complete);
          if (pending.length)
            emit(
              "images.pending",
              p.url,
              "inconclusive",
              "Images not yet loaded after bounded scrolling",
              pending,
            );
          for (const img of desktop.runtime.images)
            if (img.src) addAsset(img.src, "image", p);
          for (const background of desktop.runtime.backgrounds)
            addAsset(background, "image", p);
          if (desktop.runtime.backgrounds.length)
            emit(
              "images.background-content",
              p.url,
              "inconclusive",
              "CSS background images cannot carry img alt text",
              {
                urls: desktop.runtime.backgrounds.slice(0, 30),
                note: "Decorative backgrounds are fine; meaningful imagery should use img/picture.",
              },
              true,
            );
          if (desktop.runtime.videos.length) {
            emit(
              "video.playback",
              p.url,
              desktop.runtime.videos.some((v) => v.error)
                ? false
                : "inconclusive",
              "Video load and playback readiness",
              desktop.runtime.videos,
            );
            for (const video of desktop.runtime.videos) {
              if (video.src) addAsset(video.src, "video", p);
              if (video.poster) addAsset(video.poster, "image", p);
            }
          }
        } catch (e) {
          emit(
            "advanced.browser",
            p.url,
            "inconclusive",
            "Browser comparison could not complete",
            String(e),
          );
        }
      } else
        emit(
          "advanced.browser",
          p.url,
          "skipped",
          "Mobile, lazy-content and rendered soft-404 checks require Chromium",
          { render: o.render },
        );
      for (const [name, userAgent] of Object.entries(botAgents)) {
        const headers = Object.fromEntries(
          Object.entries(o.headers).filter(
            ([name]) => name.toLowerCase() !== "user-agent",
          ),
        );
        const bot = new Http({
          ...o,
          headers: { ...headers, "user-agent": userAgent },
        });
        try {
          const response = await bot.get(p.url, canFetch);
          if (response.error) {
            emit(
              "bots.response",
              p.url,
              "inconclusive",
              "Bot user-agent response unavailable",
              { bot: name, error: response.error },
            );
            continue;
          }
          const s = extract(response.body, response.finalUrl);
          const baseline = p.rendered ?? p.raw!;
          const google = name === "Googlebot";
          const missing = google
            ? [
                !s.titles.length && !!baseline.titles.length ? "title" : "",
                !s.canonicals.length && !!baseline.canonicals.length
                  ? "canonical"
                  : "",
              ].filter(Boolean)
            : Object.keys(baseline.social).filter((key) => !s.social[key]);
          const newlyNoindex =
            /\b(noindex|none)\b/i.test(
              directiveValues({ ...p, headers: response.headers }, s).join(","),
            ) &&
            !/\b(noindex|none)\b/i.test(directiveValues(p, baseline).join(","));
          emit(
            google ? "bots.google-response" : "social.bot-response",
            p.url,
            response.status === 200 &&
              !newlyNoindex &&
              (google || !missing.length),
            `${name} user-agent response and metadata`,
            {
              bot: name,
              status: response.status,
              missing,
              newlyNoindex,
              metadata: metadata(s),
              note: "User-agent emulation only, not an authenticated Google crawl. Googlebot may render JS; missing raw metadata is diagnostic, not proof of non-indexability.",
            },
          );
          if (google && missing.length)
            emit(
              "bots.raw-metadata",
              p.url,
              "inconclusive",
              "Googlebot user-agent raw metadata requires rendering",
              {
                missing,
                note: "Client-side metadata may be available to Google after rendering; absence in raw HTML alone is not an SEO failure.",
              },
              true,
            );
          const changes = google
            ? {
                metadata:
                  JSON.stringify(metadata(s)) !==
                  JSON.stringify(metadata(p.raw!)),
                jsonld:
                  JSON.stringify(json(s)) !== JSON.stringify(json(p.raw!)),
                mainText:
                  norm(s.mainText ?? "") !== norm(p.raw!.mainText ?? ""),
              }
            : {
                social:
                  JSON.stringify(s.social) !== JSON.stringify(baseline.social),
              };
          emit(
            google ? "bots.raw-parity" : "social.bot-parity",
            p.url,
            !Object.values(changes).some(Boolean),
            `${name} response differences`,
            {
              bot: name,
              changes,
              note: "Differences may be legitimate streaming, personalization or JS rendering; review before changing the site.",
            },
            true,
          );
        } finally {
          await bot.close();
        }
      }
    }
    if (pages.length > candidates.length)
      emit(
        "advanced.coverage",
        o.url,
        "inconclusive",
        "Advanced page probe budget reached",
        {
          eligible: pages.length,
          checked: candidates.length,
          limit: o.advancedPages,
        },
      );
    if (o.probe404) {
      for (const suffix of ["", "/nested/page"]) {
        const url = new URL(`/localseo-missing-${randomUUID()}${suffix}`, o.url)
          .href;
        const response = await http.get(url, canFetch);
        if (response.error) {
          emit(
            "http.rendered-unknown-route",
            url,
            "inconclusive",
            "Unknown-route probe blocked or failed",
            response.error,
          );
          continue;
        }
        try {
          const snapshot =
            browser && ![404, 410].includes(response.status)
              ? (await probe(url, false)).after
              : extract(response.body, response.finalUrl);
          const noindex = /\b(noindex|none)\b/i.test(
            directiveValues(
              { headers: response.headers } as Page,
              snapshot,
            ).join(","),
          );
          const matches = pages.flatMap((p) => {
            const score = similarity(
              snapshot.mainText ?? "",
              (p.rendered ?? p.raw!).mainText ?? "",
            );
            return score > 0.85 ? [{ url: p.url, similarity: score }] : [];
          });
          emit(
            "http.rendered-unknown-route",
            url,
            [404, 410].includes(response.status) || noindex
              ? true
              : "inconclusive",
            "Rendered nonexistent route and soft-404 risk",
            {
              status: response.status,
              noindex,
              title: snapshot.titles,
              matchingRealPages: matches.slice(0, 10),
              note: "Google soft-404 classification cannot be reproduced locally.",
            },
          );
        } catch (e) {
          emit(
            "http.rendered-unknown-route",
            url,
            "inconclusive",
            "Rendered nonexistent route probe failed",
            String(e),
          );
        }
      }
    }
    let processed = 0;
    for (const [key, asset] of assets) {
      const url = key.slice(key.indexOf(":") + 1);
      if (processed++ >= o.assetLimit) break;
      progress?.(
        `Checking asset ${processed}/${Math.min(assets.size, o.assetLimit)}: ${url}`,
      );
      const robotsAllowed = result.robotsAllowed?.(url) !== false;
      const needsBytes = ["image", "social"].includes(asset.type);
      const response = await http.get(url, canFetch, needsBytes);
      for (const p of asset.pages) {
        emit(
          "render.asset-robots",
          p.url,
          robotsAllowed,
          "Referenced asset blocked by robots.txt",
          { url, type: asset.type },
        );
        if (response.error) {
          emit(
            "render.asset-response",
            p.url,
            "inconclusive",
            "Asset response not verified",
            { url, type: asset.type, error: response.error },
          );
          continue;
        }
        emit(
          asset.type === "social" ? "social.image-mime" : "render.asset-mime",
          p.url,
          response.status >= 200 &&
            response.status < 300 &&
            mimeMatches(asset.type, response.headers["content-type"] ?? ""),
          "Referenced asset HTTP status and MIME type",
          {
            url,
            type: asset.type,
            status: response.status,
            mime: response.headers["content-type"],
          },
        );
        if (asset.type === "pdf")
          emit(
            "robots.non-html",
            p.url,
            "inconclusive",
            "Non-HTML indexing directives",
            {
              url,
              xRobotsTag: response.headers["x-robots-tag"] ?? null,
              note: "Noindex is a policy choice, not required. HTML meta tags cannot control PDF indexing. PDF body size is not measured.",
            },
          );
      }
      if (
        needsBytes &&
        response.bytes &&
        response.status === 200 &&
        mimeMatches(asset.type, response.headers["content-type"] ?? "")
      ) {
        if (!decoder) {
          for (const p of asset.pages)
            emit(
              asset.type === "social"
                ? "social.image-decode"
                : "images.asset-decode",
              p.url,
              "skipped",
              "Image decoding requires Chromium",
              { url },
            );
          continue;
        }
        try {
          const decoded = await decoder.evaluate(
            async ({ bytes, mime }) => {
              const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
              const blob = new Blob([data], { type: mime });
              const bitmap = await Promise.race([
                createImageBitmap(blob),
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () =>
                      reject(new Error("Image decoding exceeded 5 seconds")),
                    5000,
                  ),
                ),
              ]);
              const width = bitmap.width,
                height = bitmap.height;
              if (width * height > 32_000_000) {
                bitmap.close();
                return { width, height, thumbnail: "" };
              }
              const canvas = document.createElement("canvas");
              const scale = Math.min(1, 360 / width, 360 / height);
              canvas.width = Math.max(1, Math.round(width * scale));
              canvas.height = Math.max(1, Math.round(height * scale));
              canvas
                .getContext("2d")!
                .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
              bitmap.close();
              return {
                width,
                height,
                thumbnail: canvas.toDataURL("image/png"),
              };
            },
            {
              bytes: Buffer.from(response.bytes).toString("base64"),
              mime: response.headers["content-type"],
            },
          );
          for (const p of asset.pages) {
            emit(
              asset.type === "social"
                ? "social.image-decode"
                : "images.asset-decode",
              p.url,
              true,
              "Image bytes decode successfully",
              {
                url,
                bytes: response.size,
                width: decoded.width,
                height: decoded.height,
              },
            );
            if (asset.type === "social") {
              (p.socialPreviews ??= []).push({ url, ...decoded });
              emit(
                "social.image-shape",
                p.url,
                decoded.width >= 600 && decoded.height >= 315,
                "Social image dimensions and aspect ratio",
                {
                  url,
                  width: decoded.width,
                  height: decoded.height,
                  ratio: decoded.width / decoded.height,
                  note: "Preview guidance, not a ranking signal; platform/card requirements differ.",
                },
                true,
              );
            }
          }
        } catch (e) {
          for (const p of asset.pages)
            emit(
              asset.type === "social"
                ? "social.image-decode"
                : "images.asset-decode",
              p.url,
              /image\/svg\+xml/i.test(response.headers["content-type"] ?? "") ||
                !/InvalidStateError|EncodingError|could not be decoded|cannot decode/i.test(
                  String(e),
                )
                ? "inconclusive"
                : false,
              "Image byte decoding failed",
              { url, error: String(e) },
            );
        }
      }
    }
    if (assets.size > o.assetLimit)
      emit(
        "advanced.asset-coverage",
        o.url,
        "inconclusive",
        "Asset probe budget reached",
        { eligible: assets.size, checked: o.assetLimit },
      );
  } finally {
    await browser?.close();
    await http.close();
  }
  for (const c of checks) {
    if (
      [
        "advanced.coverage",
        "advanced.asset-coverage",
        "advanced.browser",
        "bots.response",
      ].includes(c.rule) &&
      c.outcome === "inconclusive"
    ) {
      const reason = c.rule.startsWith("advanced.")
        ? c.message
        : "One or more bot response probes failed";
      if (!result.reasons.includes(reason)) result.reasons.push(reason);
    }
  }
  return checks;
}
