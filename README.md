# localseo

Check technical SEO before deploying. Crawl a locally served production build, compare server HTML with Chromium-rendered pages, and inspect findings in your terminal or a standalone HTML report.

No account, API key, hosted service, or telemetry. A transparent technical SEO Score summarizes observed checks; it is not a ranking prediction. Findings include evidence, a rule ID, a suggested fix, and documentation.

## Run

Requires Node.js 22 or newer. Version 0.1.0 is an initial release; findings and coverage limits should be reviewed before deployment.

### GitHub release

Install the packaged release without cloning or building:

```bash
npm install -g https://github.com/eteriall/localseo/releases/download/v0.1.0/localseo-0.1.0.tgz
localseo setup
localseo http://localhost:3000
```

### From source

```bash
git clone https://github.com/eteriall/localseo.git
cd localseo
npm install
npm run build
node dist/cli.js setup
node dist/cli.js http://localhost:3000 --production-origin https://example.com
```

### npm

Published as [localseo on npm](https://www.npmjs.com/package/localseo).

```bash
npx localseo setup
npx localseo http://localhost:3000 --production-origin https://example.com
```

Start your website yourself. For a final Next.js audit, serve a production build (`next build` followed by `next start`), rather than relying on development-server behavior. Static sites can be served by any local HTTP server.

Both raw and rendered HTML are checked by default. `--render off` skips browser checks explicitly. Chromium installation is separate and missing Chromium produces an actionable error instead of silently reducing coverage.

Reports are written to `localseo-report/report.html`, `report.json`, `issues.csv`, and `summary.md`. The compact HTML report groups findings by rule and severity, counts unique affected URLs, and includes a searchable raw/rendered page inspector. It supports JSON download and copying a summary (with a file-download fallback). Open it locally; it has no external assets. Existing reports in the selected directory are replaced atomically.

## Examples

```bash
# Map public URLs to the local build, including sitemap and canonical targets
node dist/cli.js http://localhost:3000 --production-origin https://example.com

# Additional unlinked routes and dynamic content
node dist/cli.js http://localhost:3000 --urls /products/widget --wait-selector main

# Inspect pages blocked by robots.txt, intentionally
node dist/cli.js http://localhost:3000 --ignore-robots

# Local HTTPS with a self-signed certificate
node dist/cli.js https://localhost:3000 --insecure

# Optional, separate Lighthouse performance results
node dist/cli.js http://localhost:3000 --lighthouse --lighthouse-pages 2

# Explicit query route; other query URLs remain excluded by default
node dist/cli.js http://localhost:3000 --urls '/search?q=example'

# Lightweight HTTP-only checks with a custom output directory
node dist/cli.js http://localhost:3000 --render off --output audit-results

# Compare against a saved report (copy it outside the output directory first)
node dist/cli.js http://localhost:3000 --baseline previous/report.json

# Opt into HTTP and two rendered unknown-route probes for soft-404 risk
node dist/cli.js http://localhost:3000 --probe404

# Deep checks across more pages/assets, plus optional build-route reconciliation
node dist/cli.js http://localhost:3000 --advanced-pages 100 --asset-limit 300 --project-dir ../my-next-site

# Skip additional mobile/bot/media probes, retaining the original crawl checks
node dist/cli.js http://localhost:3000 --no-advanced
```

### Defaults and boundaries

| Setting                         | Default                                                  |
| ------------------------------- | -------------------------------------------------------- |
| Maximum pages / discovery depth | 500 / 20                                                 |
| HTTP / browser concurrency      | 5 / 2                                                    |
| Request and navigation timeout  | 30 seconds                                               |
| Post-load settling period       | 500 ms semantic DOM quiet window; optional wait selector |
| Sitemap files / response size   | 50 / 8 MiB                                               |
| Robots handling                 | Respect Googlebot/wildcard rules; report blocked routes  |
| Query discovery                 | Off; explicit seeds still work                           |
| Lighthouse pages                | Up to five; explicit URLs supported                      |
| Additional mobile/bot probes    | First 20 successful HTML pages; configurable             |
| Additional asset probes         | 50 URL/type pairs, same-origin only; configurable        |
| CI failure threshold            | Error                                                    |

The crawler follows internal HTML links, rendered links, sitemap indexes (including gzip), canonical/hreflang validation targets, and supplied seeds. Validation targets share the same robots, exclusions, page and depth budgets. Completely unlinked/unlisted routes cannot be discovered without supplying them. Fragments are deduplicated; path case, trailing slashes and meaningful queries are preserved. No forms are submitted and no UI controls are clicked.

Semantic settling watches document text, metadata, links and JSON-LD, not animation style changes. The wait is bounded by the request timeout and a minimum 5-second budget (or twice the quiet window, whichever is larger). An unstable DOM is marked unverified and makes coverage partial. A quiet DOM does not prove delayed asynchronous work is finished; use `--wait-selector` when a page has a known readiness marker.

Navigation stays within the configured crawl origin. `--production-origin` maps that specific public origin onto the local server; it does not silently crawl production. Third-party page resources may still load during rendering. External canonical, hreflang, and social-image targets are marked unverified instead of being treated as passed. Authentication headers are restricted to the local origin, and supplied header values are redacted from reports.

Advanced probes are enabled by default. Their separate mobile/desktop contexts block external resources and respect local exclusions/robots on every redirect. The main crawl retains its normal third-party rendering behavior. Differences caused by missing external dependencies need review. Each viewport probe waits for load, an optional readiness selector and up to two seconds of configured settling; scroll probes take six viewport-sized steps. This is bounded sampling, not Googlebot's renderer. User-agent probes do not authenticate as real Googlebot. Page/asset budget exhaustion makes coverage partial; `--render off` explicitly skips browser-only checks. Image fetches are capped at 8 MiB; larger or unsupported images are unverified. Video/PDF bodies are not downloaded and their byte size is not certified.

Lighthouse is an optional dependency; `npm install --omit=optional` leaves the technical SEO engine usable. Its results are laboratory measurements, not real-user Core Web Vitals. Device/network emulation follows Lighthouse defaults.

## What is checked

Core rules cover HTTP failures, redirects, robots, sitemaps, indexing directives, titles, descriptions, duplicate metadata, canonicals, headings, document metadata, image alt, internal links, hreflang, discovery, rendering differences, and sharing metadata.

See [the rule guide](docs/rules.md) for categories and interpretation. Each finding contains a stable `rule`, `severity`, `outcome`, URL, evidence, remediation and documentation link. Structured-data findings also identify source format/block and entity.

`confidence` separates observed facts, review heuristics, and unverified results. Exact main-content duplicates exclude navigation/header/footer text and require at least 200 characters; they are informational candidates, not a quality score. Browser-resource failures include resource URL/type/status. Anchor checks retain a bounded HTML snippet. Local metadata URL leaks, hreflang conflicts/self-references, sitemap dates/duplicate entries, and sharing/canonical consistency have dedicated rules. Error responses skip normal page-SEO checks instead of generating metadata noise.

Baseline comparisons normalize the preview origin, retain the intended production origin, and list new, disappeared and persisting finding identities. Changed scope, rule version or incomplete coverage makes a comparison non-comparable: disappeared findings are not verified fixes. `--baseline` is a CLI-only report operation, not a crawler config field.

- `passed`: the stated condition was evaluated successfully.
- `failed`: the condition was evaluated and not met.
- `skipped`: the condition did not run or did not apply.
- `inconclusive`: evidence or implemented coverage is insufficient to decide.

Errors identify concrete technical defects. Warnings need review. Informational findings describe optional improvements and context. Intentional noindex, decorative `alt=""`, multiple H1 elements, non-self-referencing canonicals and short pages are not automatically errors. JavaScript dependence is reported without claiming that Google cannot render it.

### Deep structured data

JSON-LD, Microdata and RDFa normalize into an entity graph. A bundled Schema.org vocabulary and JSON-LD context enable offline type/property recognition, inherited applicability and range checks, graph references, dates, durations, prices and relationships.

Google-specific profiles cover Article, Product/Offer, ProductGroup, Course list, VacationRental, BreadcrumbList, Organization, LocalBusiness, Event, Recipe, VideoObject, FAQPage and JobPosting. Required/recommended properties and selected conditional relationships are evaluated separately from vocabulary validity. The profiles explicitly identify manual checks and unsupported extensions. They are **not a complete clone of Google's Rich Results Test**.

Product snippets are checked independently of candidate merchant eligibility (image, positive active price and currency). Merchant checks are informational because a product page may not offer purchases; shipping, returns and loyalty policies are not fully covered. ProductGroup checks grouping identifiers and supported variation dimensions. Course list checks basic fields and embedded carousel shape; cross-page course completeness remains manual. VacationRental checks accommodation/occupancy, image count and coordinate ranges, not partner eligibility or image subjects. Video coverage targets base VideoObject and media URL evidence, not Clip/BroadcastEvent/SeekToAction extensions. External contexts are never downloaded during a scan; unknown contexts and external entity references receive coverage notices. Schema.org range/domain mismatches are warnings because its vocabulary is intentionally permissive. Google FAQ rich results were retired in May 2026; valid FAQPage vocabulary remains valid.

Machine checks cannot verify truthfulness, image relevance, content quality, geographic availability or Google's final eligibility decision. The report keeps those requirements inconclusive. The report records the rule version and vocabulary content hash.

## Configuration

### Technical SEO Score

The report shows a compact accessible colored gauge: **0–49 poor (red), 50–89 needs work (amber), 90–100 good (green)**. Category scores and the formula are expandable. JSON, terminal output and Markdown summaries contain the same score.

Only observed error/warning checks with a passed/failed result contribute. Repeated entities and raw/rendered checks are deduplicated by category/rule/URL; any failure wins. Within each rule, average the page pass rate. Within each category, weight error rules 3 and warning rules 1; equally average category scores. Category and overall values are rounded. Info, heuristic, suppressed, sharing, skipped and inconclusive results are excluded, not counted as passes. No eligible evidence produces no numeric score. Incomplete coverage or eligible unverified/skipped checks produces a **provisional** score. Disabling advanced/rendered checks therefore cannot quietly produce a fully verified score. Compare scores only for matching rule versions and scope.

This score measures the implemented technical checks, not content quality, authority, actual indexing, Core Web Vitals field data, or expected search position.

### Options

`localseo.config.json` is loaded from the working directory; use `--config` to select another file. CLI options override configuration. Unknown options and invalid values fail early. Repeat `--urls`, `--exclude`, `--header`, or `--lighthouse-urls` for multiple values.

```json
{
  "productionOrigin": "https://example.com",
  "maxPages": 500,
  "render": "both",
  "exclude": ["/admin/**"],
  "urls": ["/unlinked-page"],
  "failOn": "error",
  "severityOverrides": { "description.present": "info" },
  "suppressions": [
    {
      "rule": "description.present",
      "urlPattern": "/legal/**",
      "reason": "Intentionally omitted"
    }
  ]
}
```

Glob `*` matches within one path segment; `**` crosses segments. Suppressions retain original evidence and outcomes but exclude the finding from the failure threshold. Headers may be supplied through configuration; do not commit secrets.

Exit codes: **0** completed below the failure threshold; **1** findings reach the threshold; **2** operational failure or a partial scan. Limits/timeouts are explicit coverage failures; deliberate exclusions and robots skips define the chosen scope. `--fail-on none` disables finding-based failure, not incomplete-scan failure.

## JavaScript API

```js
import { audit, writeReport, exitCode } from "localseo";

const report = await audit({ url: "http://localhost:3000" });
await writeReport(report);
process.exitCode = exitCode(report);
```

Types are exported. JSON report schema version is `1`; additive fields may appear within that version. This initial 0.x release does not promise compatibility across minor package releases.

## Development

```bash
npm run check
npm test
npm run build
npm pack
```

Tests use local fixture sites and include browser/report and real Lighthouse integration. Run setup first. Production audits do not contact external schema validators; dependency/browser installation requires network access.

Source code is MIT licensed. Bundled Schema.org data has its own attribution in [data/NOTICE.md](data/NOTICE.md). Report bugs and suggest rules at [GitHub Issues](https://github.com/eteriall/localseo/issues). Never include credentials or private website reports in public issues.
