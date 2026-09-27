import { readFileSync } from "node:fs";
import type { Transform } from "node:stream";
import jsonld from "jsonld";
import { RdfaParser } from "rdfa-streaming-parser";
import { MicrodataRdfParser } from "microdata-rdf-streaming-parser";
import { Writer } from "n3";
import { load } from "cheerio";
import { check, docs } from "./check.js";
import type { Check, Page, Severity, Snapshot } from "./types.js";
interface Term {
  kind: string;
  parents: string[];
  domains: string[];
  ranges: string[];
  types: string[];
}
const vocabulary = JSON.parse(
  readFileSync(new URL("../data/vocabulary.json", import.meta.url), "utf8"),
) as { version: string; terms: Record<string, Term> };
export const vocabularyVersion = vocabulary.version;
export const ruleVersion = "2026-09-27.4";
const terms = vocabulary.terms;
const short = (s: string) => s.replace(/^https?:\/\/schema.org\//, "");
const arr = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
type Entity = Record<string, any>;
export function isType(
  type: string,
  expected: string,
  seen = new Set<string>(),
): boolean {
  type = short(type);
  if (type === expected) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return [
    ...(terms[type]?.parents ?? []),
    ...(terms[type]?.types ?? []).filter((t) => !t.includes(":")),
  ].some((p) => isType(p, expected, seen));
}
const context = JSON.parse(
  readFileSync(new URL("../data/context.json", import.meta.url), "utf8"),
);
const loader = async (url: string) => {
  if (/^https?:\/\/schema.org\/?(?:docs\/jsonldcontext.jsonld)?$/.test(url))
    return { contextUrl: null, documentUrl: url, document: context };
  throw new Error(`External JSON-LD context is not bundled: ${url}`);
};
async function rdf(
  html: string,
  format: string,
  baseIRI: string,
): Promise<any[]> {
  const parser = (format === "microdata"
    ? new MicrodataRdfParser({ baseIRI })
    : new RdfaParser({
        baseIRI,
        contentType: "text/html",
      })) as unknown as Transform;
  const quads: any[] = [];
  await new Promise<void>((resolve, reject) => {
    parser.on("data", (q) => quads.push(q));
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.end(html);
  });
  const writer = new Writer({ format: "N-Quads" });
  writer.addQuads(quads);
  const nquads = await new Promise<string>((resolve, reject) =>
    writer.end((e, v) => (e ? reject(e) : resolve(v))),
  );
  return (await jsonld.fromRDF(nquads, {
    format: "application/n-quads",
  })) as any[];
}
interface Profile {
  doc: string;
  required: string[];
  recommended: string[];
  note?: string;
}
export const profiles: Record<string, Profile> = {
  Article: {
    doc: "article",
    required: [],
    recommended: [
      "headline",
      "image",
      "datePublished",
      "dateModified",
      "author",
    ],
  },
  Product: {
    doc: "product-snippet",
    required: ["name"],
    recommended: ["image", "description", "sku", "brand"],
    note: "Product snippets are checked separately from candidate merchant-listing requirements; purchase eligibility and merchant policies require manual review.",
  },
  Offer: {
    doc: "product-snippet",
    required: [],
    recommended: ["priceCurrency", "availability", "url"],
    note: "Offer requirements depend on the containing Product/Event; standalone offers do not establish eligibility.",
  },
  BreadcrumbList: {
    doc: "breadcrumb",
    required: ["itemListElement"],
    recommended: [],
  },
  Organization: {
    doc: "organization",
    required: [],
    recommended: ["name", "url", "logo"],
    note: "Organization information can support entity understanding; it is not a guaranteed rich-result feature.",
  },
  LocalBusiness: {
    doc: "local-business",
    required: ["name", "address"],
    recommended: ["telephone", "url", "openingHoursSpecification", "geo"],
  },
  Event: {
    doc: "event",
    required: ["name", "startDate", "location"],
    recommended: [
      "description",
      "image",
      "endDate",
      "offers",
      "organizer",
      "performer",
      "eventStatus",
    ],
  },
  Recipe: {
    doc: "recipe",
    required: ["name", "image"],
    recommended: [
      "author",
      "description",
      "recipeIngredient",
      "recipeInstructions",
      "totalTime",
      "recipeYield",
      "nutrition",
    ],
  },
  VideoObject: {
    doc: "video",
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["description", "duration"],
    note: "Base VideoObject profile; Clip, BroadcastEvent and SeekToAction feature extensions are not evaluated.",
  },
  FAQPage: {
    doc: "https://developers.google.com/search/updates",
    required: [],
    recommended: [],
    note: "Google FAQ rich results were retired May 7, 2026. Schema.org validity remains independently meaningful.",
  },
  JobPosting: {
    doc: "job-posting",
    required: ["title", "description", "datePosted", "hiringOrganization"],
    recommended: ["validThrough", "employmentType", "identifier", "baseSalary"],
  },
  ProductGroup: {
    doc: "product-variants",
    required: ["name"],
    recommended: ["variesBy", "brand"],
    note: "Variant grouping is checked; single-page versus multi-page commerce eligibility requires review.",
  },
  Course: {
    doc: "course",
    required: ["name", "description"],
    recommended: ["provider"],
    note: "Course list profile, not the retired Course info feature. At least three courses and carousel markup are required across the relevant pages; educational eligibility and language require review.",
  },
  VacationRental: {
    doc: "vacation-rental",
    required: ["name", "identifier", "image", "containsPlace"],
    recommended: ["address", "brand"],
    note: "Partial vacation-rental profile. Google integration eligibility, photo subjects and stable cross-language identifiers require manual review.",
  },
};
export async function schemaRules(
  p: Page,
  s: Snapshot,
  phase = "rendered",
): Promise<Check[]> {
  const checks: Check[] = [];
  const emit = (
    rule: string,
    severity: Severity,
    valid: boolean | "inconclusive" | "skipped",
    message: string,
    evidence: unknown,
    source: string,
    doc = "https://schema.org/docs/schemas.html",
    remediation = "Correct the markup using the documented vocabulary and property requirements.",
  ) => {
    checks.push({
      ...check(
        rule,
        "Structured data",
        p.url,
        severity,
        valid,
        message,
        evidence,
        remediation,
        doc,
      ),
      source: `${phase}: ${source}`,
    });
  };
  if (!s.structured.length) {
    emit(
      "schema.present",
      "info",
      "skipped",
      "No structured data found",
      null,
      "document",
    );
    return checks;
  }
  const graph = new Map<string, Entity>();
  const origins = new Map<string, string>();
  let serial = 0;
  function merge(expanded: any, source: string, prefix: string): void {
    const visit = (v: any): any => {
      if (Array.isArray(v)) return v.map(visit);
      if (!v || typeof v !== "object") return v;
      if ("@value" in v) return v;
      if ("@list" in v) return { "@list": visit(v["@list"]) };
      const id =
        typeof v["@id"] === "string"
          ? v["@id"].startsWith("_:")
            ? prefix + v["@id"]
            : v["@id"]
          : `${prefix}_:generated${serial++}`;
      const node = graph.get(id) ?? { "@id": id };
      origins.set(id, source);
      for (const [k, value] of Object.entries(v)) {
        if (k === "@id") continue;
        if (k === "@graph") {
          visit(value);
          continue;
        }
        const key = k.startsWith("@") ? k : short(k);
        const values =
          k === "@type" ? arr(value).map(short) : arr(value).map(visit);
        node[key] = [
          ...new Map(
            [...(node[key] ?? []), ...values].map((x) => [
              JSON.stringify(x),
              x,
            ]),
          ).values(),
        ];
      }
      graph.set(id, node);
      return { "@id": id };
    };
    visit(expanded);
  }
  for (const [i, block] of s.structured.entries()) {
    try {
      let expanded: any;
      if (block.format === "jsonld") {
        const value = JSON.parse(block.value);
        if (!value || typeof value !== "object")
          throw new Error("JSON-LD must be an object or array");
        const hasContext = arr(value).some((v) => v && "@context" in v);
        emit(
          "schema.context",
          "warning",
          hasContext,
          "JSON-LD context declaration",
          hasContext,
          block.source,
        );
        expanded = await jsonld.expand(value, {
          base: p.publicUrl,
          documentLoader: loader as any,
        });
      } else expanded = await rdf(block.value, block.format, p.publicUrl);
      emit(
        "schema.syntax",
        "error",
        true,
        `${block.format} parsed`,
        { nodes: expanded.length },
        block.source,
      );
      if (!expanded.length)
        emit(
          "schema.expansion",
          "warning",
          "inconclusive",
          "No entities survived vocabulary expansion",
          null,
          block.source,
        );
      merge(expanded, block.source, `_:block${i}:`);
    } catch (e) {
      const message = (e as Error).message;
      const external =
        message.includes("remote context") ||
        message.includes("External JSON-LD");
      emit(
        external ? "schema.context" : "schema.syntax",
        external ? "warning" : "error",
        external ? "inconclusive" : false,
        `${block.format} could not be fully interpreted`,
        message,
        block.source,
      );
    }
  }
  const resolve = (v: any): any =>
    v?.["@id"] ? (graph.get(v["@id"]) ?? v) : v;
  const values = (n: Entity, key: string): any[] =>
    arr(n[key])
      .flatMap((v) => v?.["@list"] ?? [v])
      .map(resolve);
  const scalar = (v: any): any =>
    v?.["@value"] ??
    (v?.["@id"] && !Object.keys(v).some((k) => !k.startsWith("@"))
      ? v["@id"]
      : v);
  const first = (n: Entity, key: string) => scalar(values(n, key)[0]);
  const present = (n: Entity, key: string) =>
    values(n, key).some((v) => {
      const x = scalar(v);
      return x !== undefined && x !== null && x !== "";
    });
  const types = (n: Entity): string[] => arr(n["@type"]);
  const has = (n: Entity, t: string) => types(n).some((x) => isType(x, t));
  const flatText = (v: any) =>
    typeof v === "string"
      ? load(`<body>${v}</body>`)("body").text().replace(/\s+/g, " ").trim()
      : "";
  const validURL = (v: any) => {
    try {
      return (
        typeof v === "string" &&
        ["http:", "https:"].includes(new URL(v).protocol)
      );
    } catch {
      return false;
    }
  };
  const date = (v: any) =>
    typeof v === "string" &&
    /^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?$/.test(
      v,
    ) &&
    !Number.isNaN(Date.parse(v)) &&
    new Date(v.slice(0, 10)).toISOString().slice(0, 10) === v.slice(0, 10);
  const duration = (v: any) =>
    typeof v === "string" &&
    /^P(?=\d|T\d)(?:\d+(?:\.\d+)?W|(?:\d+Y)?(?:\d+M)?(?:\d+(?:\.\d+)?D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?)$/.test(
      v,
    );
  const matches = (v: any, range: string): boolean => {
    const raw = scalar(v);
    if (range === "Text") return typeof raw === "string";
    if (range === "URL") return validURL(raw);
    if (range === "Date") return date(raw) && !raw.includes("T");
    if (range === "DateTime") return date(raw) && raw.includes("T");
    if (range === "Time")
      return (
        typeof raw === "string" &&
        /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(
          raw,
        )
      );
    if (range === "Duration") return duration(raw);
    if (range === "Number" || range === "Float")
      return (
        (typeof raw === "number" || typeof raw === "string") &&
        String(raw).trim() !== "" &&
        Number.isFinite(Number(raw))
      );
    if (range === "Integer")
      return (
        (typeof raw === "number" || typeof raw === "string") &&
        String(raw).trim() !== "" &&
        Number.isInteger(Number(raw))
      );
    if (range === "Boolean")
      return (
        typeof raw === "boolean" ||
        [
          "true",
          "false",
          "https://schema.org/True",
          "https://schema.org/False",
        ].includes(raw)
      );
    if (v && typeof v === "object" && has(v, range)) return true;
    if (typeof raw === "string" && /^https?:\/\/schema.org\//.test(raw))
      return isType(short(raw), range);
    return false;
  };
  for (const [id, n] of graph) {
    const source = `${origins.get(id)}, entity ${id}`;
    const nt = types(n);
    if (!nt.length && Object.keys(n).length === 1) continue;
    // Schema.org allows lists of values and names in several languages. Possible conflicts need review.
    for (const prop of [
      "sku",
      "productGroupID",
      "priceCurrency",
      "datePublished",
      "startDate",
      "endDate",
      "birthDate",
    ])
      if (
        new Set(values(n, prop).map((v) => JSON.stringify(scalar(v)))).size > 1
      ) {
        emit(
          "schema.entity-conflict",
          "info",
          "inconclusive",
          "One entity has multiple potentially conflicting identity/date values",
          { id, property: prop, values: values(n, prop) },
          source,
        );
        checks[checks.length - 1].confidence = "heuristic";
      }
    for (const [prop, expected] of Object.entries({
      author: ["Person", "Organization"],
      publisher: ["Person", "Organization"],
      brand: ["Brand", "Organization"],
      isVariantOf: ["ProductGroup"],
      hasVariant: ["Product"],
      aggregateRating: ["AggregateRating"],
    })) {
      for (const target of values(n, prop)) {
        if (!types(target).length) continue;
        emit(
          "schema.relationship-type",
          "warning",
          expected.some((type) => has(target, type)),
          "Structured-data relationship target type",
          {
            entity: id,
            property: prop,
            expected,
            actual: types(target),
            target: target["@id"],
          },
          source,
        );
      }
    }
    for (const prop of [
      "price",
      "lowPrice",
      "highPrice",
      "ratingValue",
      "ratingCount",
      "reviewCount",
      "startDate",
      "endDate",
      "datePublished",
      "availability",
    ]) {
      if (!present(n, prop)) continue;
      const value = first(n, prop),
        label =
          typeof value === "string" || typeof value === "number"
            ? String(value)
            : "";
      emit(
        "schema.visible-values",
        "info",
        "inconclusive",
        "Structured value versus page content",
        {
          entity: id,
          property: prop,
          value,
          literalFound:
            !!label && s.text.toLowerCase().includes(label.toLowerCase()),
          note: "A literal match does not associate a price/rating with the right entity. Localized numbers, dates and availability labels require review.",
        },
        source,
        docs + "appearance/structured-data/sd-policies",
      );
    }
    emit(
      "schema.type",
      "warning",
      nt.length > 0,
      "Entity type declaration",
      nt,
      source,
    );
    for (const t of nt)
      emit(
        "schema.type-known",
        "warning",
        terms[t]?.kind === "type"
          ? true
          : t.includes(":")
            ? "inconclusive"
            : false,
        "Schema.org type recognition",
        t,
        source,
      );
    for (const [prop, items] of Object.entries(n)) {
      if (prop.startsWith("@")) continue;
      const definition = terms[prop];
      if (!definition || definition.kind !== "property") {
        emit(
          "schema.property-known",
          "warning",
          prop.includes(":") ? "inconclusive" : false,
          "Property vocabulary recognition",
          prop,
          source,
        );
        continue;
      }
      emit(
        "schema.property-domain",
        "warning",
        !nt.length ||
          !definition.domains.length ||
          nt.some((t) => definition.domains.some((d) => isType(t, d))),
        "Property applicability",
        { prop, types: nt, expected: definition.domains },
        source,
      );
      for (const original of arr(items).flatMap((v) => v?.["@list"] ?? [v])) {
        const v = resolve(original),
          raw = scalar(v);
        if (
          original?.["@id"] &&
          !definition.ranges.includes("URL") &&
          !/^https?:\/\/schema.org\//.test(original["@id"]) &&
          (!graph.has(original["@id"]) ||
            Object.keys(graph.get(original["@id"])!).length === 1)
        ) {
          const target = original["@id"];
          const local =
            target.startsWith(p.publicUrl.split("#")[0] + "#") ||
            target.startsWith("_:");
          emit(
            "schema.reference",
            "warning",
            local ? false : "inconclusive",
            local
              ? "Unresolved local entity reference"
              : "External entity not dereferenced",
            { prop, target },
            source,
          );
          continue;
        }
        const rs = definition.ranges;
        // Schema.org permits loose textual values; range mismatches are warnings, never eligibility claims.
        if (rs.length)
          emit(
            "schema.property-range",
            "warning",
            (prop === "item" && has(n, "ListItem") && validURL(raw)) ||
              rs.some((r) => matches(v, r)),
            "Property value range",
            { prop, value: raw, expected: rs },
            source,
          );
        if (
          /^(date|startDate$|endDate$|uploadDate$|validThrough$|validFrom$|priceValidUntil$)/.test(
            prop,
          ) &&
          typeof raw === "string"
        )
          emit(
            "schema.date",
            "error",
            date(raw),
            "ISO date validity",
            { prop, value: raw },
            source,
          );
        if (["duration", "totalTime", "prepTime", "cookTime"].includes(prop))
          emit(
            "schema.duration",
            "error",
            duration(raw),
            "ISO duration validity",
            { prop, value: raw },
            source,
          );
        if (prop === "priceCurrency")
          emit(
            "schema.currency",
            "error",
            typeof raw === "string" && /^[A-Z]{3}$/.test(raw),
            "Currency code format",
            raw,
            source,
          );
        if (["price", "lowPrice", "highPrice"].includes(prop))
          emit(
            "schema.price",
            "error",
            Number.isFinite(Number(raw)) &&
              Number(raw) >= 0 &&
              String(raw).trim() !== "",
            "Nonnegative numeric price",
            raw,
            source,
          );
      }
    }
    for (const [start, end] of [
      ["startDate", "endDate"],
      ["datePublished", "dateModified"],
      ["datePosted", "validThrough"],
    ])
      if (
        present(n, start) &&
        present(n, end) &&
        date(first(n, start)) &&
        date(first(n, end))
      )
        emit(
          "schema.date-order",
          "error",
          Date.parse(first(n, start)) <= Date.parse(first(n, end)),
          "Date ordering",
          { [start]: first(n, start), [end]: first(n, end) },
          source,
        );
    const matching = Object.keys(profiles)
      .filter((t) => has(n, t))
      .filter((t) => t !== "Organization" || !has(n, "LocalBusiness"))
      .filter((t) => t !== "Product" || !has(n, "ProductGroup"));
    if (!matching.length && nt.length)
      emit(
        "schema.google-coverage",
        "info",
        "inconclusive",
        "No Google-specific profile for this entity",
        nt,
        source,
        docs + "appearance/structured-data/search-gallery",
      );
    for (const name of matching) {
      const profile = profiles[name];
      const doc = profile.doc.startsWith("https:")
        ? profile.doc
        : docs + "appearance/structured-data/" + profile.doc;
      const rule = (
        suffix: string,
        valid: boolean | "inconclusive",
        message: string,
        evidence: unknown,
        severity: Severity = "error",
      ) =>
        emit(
          `schema.google.${name}.${suffix}`,
          severity,
          valid,
          message,
          evidence,
          source,
          doc,
        );
      const require = (node: Entity, fields: string[], label = name) => {
        for (const field of fields)
          rule(
            "required",
            present(node, field),
            `${label}.${field} is required`,
            { field, value: node[field] },
          );
      };
      require(n, profile.required);
      for (const field of profile.recommended)
        rule(
          "recommended",
          present(n, field),
          `${name}.${field} is recommended`,
          { field, value: n[field] },
          "info",
        );
      if (profile.note)
        rule("coverage", "inconclusive", profile.note, nt, "info");
      if (name === "FAQPage") continue;
      rule(
        "manual",
        "inconclusive",
        "Manual eligibility review required: accuracy, visible content, image relevance, site policies, access and Google feature availability are not fully machine-verifiable.",
        name,
        "info",
      );
      if (name === "Article")
        for (const author of values(n, "author")) {
          if (typeof scalar(author) === "string")
            rule(
              "author",
              false,
              "Author should identify a Person or Organization",
              author,
              "warning",
            );
          else require(author, ["name"], "author");
        }
      if (name === "Product") {
        rule(
          "alternatives",
          ["offers", "review", "aggregateRating"].some((k) => present(n, k)),
          "Product needs offers, review or aggregateRating",
          nt,
        );
        for (const offer of values(n, "offers")) {
          rule(
            "offer-type",
            has(offer, "Offer"),
            "Product offers must identify Offer or AggregateOffer",
            types(offer),
          );
          if (has(offer, "AggregateOffer"))
            require(offer, ["lowPrice", "priceCurrency"], "AggregateOffer");
          else
            rule(
              "offer-price",
              present(offer, "price") ||
                values(offer, "priceSpecification").some((x) =>
                  present(x, "price"),
                ),
              "Offer needs price or priceSpecification.price",
              offer,
            );
        }
        const offers = values(n, "offers").filter(
          (offer) => has(offer, "Offer") && !has(offer, "AggregateOffer"),
        );
        if (offers.length) {
          const missing = ["name", "image"].filter(
            (field) => !present(n, field),
          );
          const invalidOffers = offers.flatMap((offer) => {
            const priceNode = present(offer, "price")
              ? offer
              : values(offer, "priceSpecification").find(
                  (spec) =>
                    present(spec, "price") &&
                    !present(spec, "priceType") &&
                    !present(spec, "validForMemberTier"),
                );
            return !priceNode ||
              !(Number(first(priceNode, "price")) > 0) ||
              !/^[A-Z]{3}$/.test(
                String(first(priceNode, "priceCurrency") ?? ""),
              )
              ? [
                  {
                    offer: offer["@id"],
                    price: priceNode && first(priceNode, "price"),
                    currency: priceNode && first(priceNode, "priceCurrency"),
                  },
                ]
              : [];
          });
          emit(
            "schema.google.MerchantListing.candidate",
            "info",
            !missing.length && !invalidOffers.length,
            "Candidate merchant-listing image, active price and currency",
            {
              missing,
              invalidOffers,
              note: "Only applies if purchases are available on this site; product snippets can be valid without merchant eligibility. Shipping, returns, loyalty and policy eligibility are not fully covered.",
            },
            source,
            docs + "appearance/structured-data/merchant-listing",
          );
        }
      }
      if (name === "ProductGroup") {
        const variants = [
          ...values(n, "hasVariant"),
          ...[...graph.values()].filter((v) =>
            arr(v.isVariantOf).some((ref) => ref["@id"] === id),
          ),
        ];
        const groupID = first(n, "productGroupID");
        rule(
          "identifier",
          !!groupID ||
            (variants.length > 0 &&
              variants.every((v) => present(v, "inProductGroupWithID"))),
          "ProductGroup or its variants need a group identifier",
          {
            groupID,
            variantIDs: variants.map((v) => first(v, "inProductGroupWithID")),
          },
        );
        const ids = new Set(
          [
            groupID,
            ...variants.map((v) => first(v, "inProductGroupWithID")),
          ].filter(Boolean),
        );
        rule(
          "identifier-consistency",
          ids.size <= 1,
          "Variant identifiers must agree with their group",
          [...ids],
        );
        rule(
          "variants",
          variants.length > 0 ? true : "inconclusive",
          "Variant references present in the local graph",
          { count: variants.length },
          "warning",
        );
        const unsupported = values(n, "variesBy")
          .map(scalar)
          .filter(
            (v) =>
              typeof v !== "string" ||
              !/^https?:\/\/schema.org\/(color|size|suggestedAge|suggestedGender|material|pattern)$/.test(
                v,
              ),
          );
        rule(
          "variesBy",
          !unsupported.length,
          "Google-supported variant dimensions",
          unsupported,
          "warning",
        );
      }
      if (name === "Course") {
        for (const provider of values(n, "provider"))
          rule(
            "provider",
            has(provider, "Organization") && present(provider, "name"),
            "Course provider identifies an organization",
            provider,
            "warning",
          );
        const lists = [...graph.values()].filter((v) => has(v, "ItemList"));
        for (const list of lists) {
          const items = values(list, "itemListElement");
          if (
            !items.some((item) =>
              values(item, "item").some((v) => has(v, "Course")),
            )
          )
            continue;
          rule(
            "carousel",
            items.length >= 3 &&
              items.every(
                (item) =>
                  has(item, "ListItem") &&
                  Number.isInteger(Number(first(item, "position"))) &&
                  Number(first(item, "position")) > 0,
              ),
            "Course carousel requires at least three positioned list items",
            { count: items.length },
            "warning",
          );
        }
      }
      if (name === "VacationRental") {
        const places = values(n, "containsPlace");
        rule(
          "accommodation",
          places.length === 1 && has(places[0], "Accommodation"),
          "Vacation rental contains one Accommodation",
          places,
        );
        for (const place of places) {
          const occupancy = values(place, "occupancy");
          rule(
            "occupancy",
            occupancy.some(
              (v) =>
                has(v, "QuantitativeValue") &&
                Number.isInteger(Number(first(v, "value"))) &&
                Number(first(v, "value")) > 0,
            ),
            "Accommodation needs positive integer occupancy",
            occupancy,
          );
        }
        rule(
          "images",
          new Set(values(n, "image").map((v) => JSON.stringify(v))).size >= 8,
          "Vacation rental needs at least eight images",
          values(n, "image").length,
        );
        const geo = values(n, "geo")[0];
        for (const field of ["latitude", "longitude"]) {
          const value = first(n, field) ?? (geo && first(geo, field));
          const bound = field === "latitude" ? 90 : 180;
          rule(
            "coordinates",
            value !== undefined &&
              Number.isFinite(Number(value)) &&
              Math.abs(Number(value)) <= bound,
            "Vacation rental coordinates",
            { field, value },
          );
          rule(
            "coordinate-precision",
            /\.\d{5,}/.test(String(value)) ? true : "inconclusive",
            "Five-decimal coordinate precision needs verification",
            {
              field,
              value,
              note: "JSON numbers may lose trailing zero precision.",
            },
            "info",
          );
        }
      }
      if (name === "VideoObject") {
        const sources = values(n, "contentUrl").map(scalar),
          thumbnails = values(n, "thumbnailUrl").map(scalar);
        const videos = s.technical?.videos ?? [];
        if (s.technical) {
          s.technical.schemaMedia ??= [];
          for (const [prop, type] of [
            ["thumbnailUrl", "image"],
            ["contentUrl", "video"],
            ["embedUrl", "embed"],
          ])
            for (const value of values(n, prop).map(scalar))
              if (validURL(value))
                s.technical.schemaMedia.push({ url: value, type });
        }
        rule(
          "page-consistency",
          videos.some((video) => sources.includes(video.src))
            ? true
            : "inconclusive",
          "Video schema content URL compared with HTML video",
          {
            schemaSources: sources,
            thumbnails,
            videos,
            note: "Embedded players, blob URLs and lazy sources require manual review.",
          },
          "info",
        );
      }
      if (name === "BreadcrumbList") {
        const list = values(n, "itemListElement").sort(
          (a, b) => Number(first(a, "position")) - Number(first(b, "position")),
        );
        rule(
          "length",
          list.length >= 2,
          "Breadcrumb trail must contain at least two ListItems",
          list.length,
        );
        list.forEach((item, i) => {
          require(item, ["position"], "ListItem");
          rule(
            "item-type",
            has(item, "ListItem"),
            "Breadcrumb element must be a ListItem",
            types(item),
          );
          rule(
            "position",
            Number(first(item, "position")) === i + 1,
            "Breadcrumb positions must start at one and be consecutive",
            first(item, "position"),
          );
          rule(
            "name",
            present(item, "name") ||
              values(item, "item").some((x) => present(x, "name")),
            "Breadcrumb item needs a name",
            item,
          );
          if (i < list.length - 1) require(item, ["item"], "ListItem");
        });
      }
      if (name === "LocalBusiness")
        for (const address of values(n, "address")) {
          rule(
            "address-type",
            has(address, "PostalAddress"),
            "Business address should be a PostalAddress",
            address,
            "warning",
          );
          if (has(address, "PostalAddress"))
            require(address, [
              "streetAddress",
              "addressLocality",
              "addressCountry",
            ], "address");
        }
      if (name === "Event") {
        for (const location of values(n, "location")) {
          rule(
            "location-type",
            has(location, "Place"),
            "Google event profile requires a physical Place",
            types(location),
          );
          require(location, ["address"], "location");
          if (!present(location, "name"))
            rule(
              "location-name",
              false,
              "Provide the venue name",
              null,
              "warning",
            );
        }
        for (const offer of values(n, "offers"))
          require(offer, ["price", "priceCurrency", "url"], "event offers");
      }
      if (name === "Recipe") {
        if (values(n, "nutrition").some((x) => present(x, "calories")))
          rule(
            "yield",
            present(n, "recipeYield"),
            "recipeYield is needed when calories are supplied",
            n.recipeYield,
          );
        for (const step of values(n, "recipeInstructions"))
          if (has(step, "HowToStep"))
            rule(
              "step",
              present(step, "text") || present(step, "itemListElement"),
              "HowToStep needs text or itemListElement",
              step,
            );
          else if (has(step, "HowToSection"))
            require(step, ["itemListElement"], "HowToSection");
      }
      if (name === "VideoObject")
        rule(
          "media-url",
          present(n, "contentUrl") || present(n, "embedUrl"),
          "Provide contentUrl or embedUrl",
          null,
          "warning",
        );
      if (name === "JobPosting") {
        const remote = first(n, "jobLocationType") === "TELECOMMUTE";
        if (remote) require(n, ["applicantLocationRequirements"], "remote job");
        else require(n, ["jobLocation"], "job");
        for (const employer of values(n, "hiringOrganization"))
          require(employer, ["name"], "hiringOrganization");
        for (const location of values(n, "jobLocation")) {
          require(location, ["address"], "jobLocation");
          for (const address of values(location, "address"))
            require(address, ["addressCountry"], "jobLocation.address");
        }
        if (present(n, "validThrough") && date(first(n, "validThrough")))
          rule(
            "expiry",
            Date.parse(first(n, "validThrough")) > Date.now(),
            "Job expiration date",
            first(n, "validThrough"),
            "warning",
          );
      }
      for (const prop of ["headline", "title", "name"])
        if (present(n, prop)) {
          const text = flatText(first(n, prop));
          if (text.length > 3)
            rule(
              "visible-content",
              s.text.toLowerCase().includes(text.toLowerCase())
                ? true
                : "inconclusive",
              "Entity label visibility needs review when no exact text match is found",
              { prop, value: text },
              "info",
            );
        }
    }
    if (has(n, "Rating")) {
      const rating = Number(first(n, "ratingValue")),
        low = Number(first(n, "worstRating") ?? 1),
        high = Number(first(n, "bestRating") ?? 5);
      emit(
        "schema.rating",
        "error",
        Number.isFinite(rating) &&
          rating >= low &&
          rating <= high &&
          low < high,
        "Rating scale consistency",
        { rating, low, high },
        source,
      );
      if (has(n, "AggregateRating"))
        emit(
          "schema.rating-count",
          "error",
          values(n, "ratingCount")
            .concat(values(n, "reviewCount"))
            .some((v) => Number(scalar(v)) > 0),
          "AggregateRating needs a positive ratingCount or reviewCount",
          n,
          source,
        );
    }
    if (has(n, "Review"))
      for (const field of ["author", "reviewRating"])
        emit(
          "schema.review",
          "warning",
          present(n, field),
          `Review ${field}`,
          n[field],
          source,
        );
  }
  return checks;
}
