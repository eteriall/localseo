import { load } from "cheerio";
import type { Snapshot } from "./types.js";
export function parseSrcset(value: string): {
  candidates: { url: string; descriptor: string }[];
  issues: string[];
} {
  const candidates: { url: string; descriptor: string }[] = [],
    issues: string[] = [];
  let rest = value.trim();
  while (rest) {
    rest = rest.replace(/^[\s,]+/, "");
    const token = /^\S+/.exec(rest)?.[0];
    if (!token) break;
    rest = rest.slice(token.length);
    let url = token,
      descriptor = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      const end = rest.indexOf(",");
      descriptor = (end < 0 ? rest : rest.slice(0, end)).trim();
      rest = end < 0 ? "" : rest.slice(end + 1);
    }
    if (
      (descriptor &&
        !/^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) ||
      (descriptor.endsWith("x") && Number(descriptor.slice(0, -1)) <= 0)
    )
      issues.push(`Invalid descriptor: ${descriptor}`);
    candidates.push({ url, descriptor: descriptor || "1x" });
  }
  const descriptors = candidates.map((c) => c.descriptor);
  if (new Set(descriptors).size !== descriptors.length)
    issues.push("Duplicate candidate descriptors");
  if (
    descriptors.some((d) => d.endsWith("w")) &&
    descriptors.some((d) => d.endsWith("x"))
  )
    issues.push("Mixed width and density descriptors");
  return { candidates, issues };
}
export function extract(html: string, url: string): Snapshot {
  const $ = load(html, { sourceCodeLocationInfo: true });
  const baseValue = $("base[href]").first().attr("href");
  let base = url;
  try {
    if (baseValue) base = new URL(baseValue, url).href;
  } catch {}
  const resolve = (s: string) => {
    try {
      return new URL(s, base).href;
    } catch {
      return s;
    }
  };
  const texts = (selector: string) =>
    $(selector)
      .toArray()
      .map((e) => $(e).text().trim());
  const attrs = (selector: string, attr: string) =>
    $(selector)
      .toArray()
      .map((e) => $(e).attr(attr) ?? "");
  const snapshot: Snapshot = {
    titles: texts("title"),
    descriptions: attrs('meta[name="description" i]', "content"),
    canonicals: attrs('link[rel~="canonical" i]', "href").map((v) =>
      v ? resolve(v) : "",
    ),
    robots: attrs('meta[name="robots" i],meta[name="googlebot" i]', "content"),
    headings: $("h1,h2,h3,h4,h5,h6")
      .toArray()
      .map((e) => ({
        level: Number(e.tagName.slice(1)),
        text: $(e).text().trim(),
      })),
    links: attrs("a[href]", "href")
      .filter((v) => v.trim())
      .map(resolve)
      .filter((value) => {
        try {
          const target = new URL(value);
          const document = new URL(url);
          document.hash = "";
          if (!target.hash) return true;
          target.hash = "";
          return target.href !== document.href;
        } catch {
          return true;
        }
      }),
    images: $("img")
      .toArray()
      .map((e) => ({
        src: $(e).attr("src") ? resolve($(e).attr("src")!) : "",
        alt: $(e).attr("alt"),
      })),
    hreflang: $('link[rel~="alternate" i][hreflang]')
      .toArray()
      .map((e) => ({
        lang: $(e).attr("hreflang") ?? "",
        href: resolve($(e).attr("href") ?? ""),
      })),
    lang: $("html").attr("lang") ?? "",
    viewport: $('meta[name="viewport" i]').attr("content") ?? "",
    charset: $('meta[charset],meta[http-equiv="content-type" i]').length > 0,
    refresh: attrs('meta[http-equiv="refresh" i]', "content"),
    social: {},
    text: "",
    anchorIssues: $("a")
      .toArray()
      .flatMap((e) => {
        const href = ($(e).attr("href") ?? "").trim();
        const reason =
          !href || /^javascript:/i.test(href)
            ? "No crawlable href"
            : !$(e).text().trim() &&
                !$(e).attr("aria-label") &&
                !$(e)
                  .find("img[alt]")
                  .toArray()
                  .some((i) => $(i).attr("alt")?.trim())
              ? "No accessible link label"
              : "";
        return reason ? [{ html: $.html(e).slice(0, 600), reason }] : [];
      }),
    structured: [],
    technical: {
      bytes: Buffer.byteLength(html),
      headIssues: [],
      resources: [],
      responsiveImages: $("img")
        .toArray()
        .map((e) => ({
          src: $(e).attr("src") ? resolve($(e).attr("src")!) : "",
          srcset: $(e).attr("srcset") ?? "",
          sizes: $(e).attr("sizes") ?? "",
          width: $(e).attr("width"),
          height: $(e).attr("height"),
          picture: $(e).parent("picture").length > 0,
        })),
      videos: $("video")
        .toArray()
        .map((e) => ({
          src:
            $(e).attr("src") || $(e).find("source[src]").first().attr("src")
              ? resolve(
                  $(e).attr("src") ||
                    $(e).find("source[src]").first().attr("src")!,
                )
              : "",
          poster: $(e).attr("poster") ? resolve($(e).attr("poster")!) : "",
          loading: $(e).attr("loading") ?? "",
        })),
      pagination: $("a[rel],link[rel]")
        .toArray()
        .flatMap((e) =>
          /\b(next|prev)\b/i.test($(e).attr("rel") ?? "") && $(e).attr("href")
            ? [{ rel: $(e).attr("rel")!, url: resolve($(e).attr("href")!) }]
            : [],
        ),
      snippetElements: $("[data-nosnippet]")
        .toArray()
        .map((e) => ({
          tag: e.tagName,
          value: $(e).attr("data-nosnippet") ?? "",
        })),
      contentAfterLimit:
        Buffer.byteLength(html) > 2 * 1024 * 1024 &&
        /<(?:main|article|h1|title|meta|link)\b/i.test(
          Buffer.from(html)
            .subarray(2 * 1024 * 1024)
            .toString(),
        ),
    },
  };
  const tech = snapshot.technical!;
  tech.srcsets = $("img[srcset],picture source[srcset]")
    .toArray()
    .map((e) => {
      const parsed = parseSrcset($(e).attr("srcset") ?? "");
      for (const candidate of parsed.candidates)
        candidate.url = resolve(candidate.url);
      return { source: $.html(e).slice(0, 400), ...parsed };
    });
  for (const set of tech.srcsets)
    for (const candidate of set.candidates)
      tech.resources.push({ url: candidate.url, type: "image" });
  // Source locations reveal elements that HTML parsing moved out of an invalid head.
  const headStart = html.search(/<head(?:\s|>)/i),
    headEnd = html.search(/<\/head\s*>/i);
  if (headStart >= 0 && headEnd > headStart) {
    $("*").each((_, e) => {
      if (!("tagName" in e)) return;
      const offset = e.sourceCodeLocation?.startOffset;
      if (offset === undefined || offset <= headStart || offset >= headEnd)
        return;
      if (
        !$(e).parents("template,script,style,noscript").length &&
        ![
          "head",
          "title",
          "meta",
          "link",
          "script",
          "style",
          "base",
          "noscript",
          "template",
        ].includes(e.tagName)
      )
        tech.headIssues.push(
          `${e.tagName} at line ${e.sourceCodeLocation?.startLine}`,
        );
    });
  }
  $(
    "script[src],link[rel~='stylesheet'][href],img[src],video[src],video source[src],video[poster]",
  ).each((_, e) => {
    const attr = e.tagName === "link" ? "href" : "src";
    const value = $(e).attr(attr);
    if (value)
      tech.resources.push({
        url: resolve(value),
        type:
          e.tagName === "script"
            ? "script"
            : e.tagName === "link"
              ? "stylesheet"
              : e.tagName === "img"
                ? "image"
                : "video",
      });
    const poster = $(e).attr("poster");
    if (poster) tech.resources.push({ url: resolve(poster), type: "image" });
  });
  $("meta[property],meta[name]").each((_, e) => {
    const key = (
      $(e).attr("property") ??
      $(e).attr("name") ??
      ""
    ).toLowerCase();
    if (/^(og:|twitter:)/.test(key))
      snapshot.social[key] = $(e).attr("content") ?? "";
  });
  $('script[type="application/ld+json" i]').each((i, e) => {
    snapshot.structured.push({
      format: "jsonld",
      source: `script[application/ld+json] #${i + 1}, line ${e.sourceCodeLocation?.startLine ?? "?"}`,
      value: $(e).html() ?? "",
    });
  });
  if ($("[itemscope]").length)
    snapshot.structured.push({
      format: "microdata",
      source: "document Microdata",
      value: html,
    });
  if ($("[typeof],[vocab],[prefix]").length)
    snapshot.structured.push({
      format: "rdfa",
      source: "document RDFa",
      value: html,
    });
  // Mutate only after extracting all metadata, links, images and structured data.
  $('script,style,template,noscript,[hidden],[aria-hidden="true"]').remove();
  snapshot.text = $("body").text().replace(/\s+/g, " ").trim();
  $("nav,header,footer,aside").remove();
  snapshot.mainText = ($("main").length ? $("main") : $("body"))
    .text()
    .replace(/\s+/g, " ")
    .trim();
  return snapshot;
}
