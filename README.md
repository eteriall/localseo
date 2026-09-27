# localseo

Check your website's SEO before you put it online. localseo works with Next.js, React and static sites. It follows links, checks each page, and saves a report with problems and steps to fix them.

You can run it on localhost. You do not need an account or an API key. The tool does not collect usage data.

## Run a check

You need Node.js 22 or newer. Start your website, then run:

```bash
npx localseo setup
npx localseo http://localhost:3000
```

The first command installs Chromium. Run it once before your first browser check.

For Next.js, use a production build for the final check: run `next build`, then `next start`. A development server can give different results. For a static site, start a local HTTP server.

If your pages use your public domain in links or tags, add it:

```bash
npx localseo http://localhost:3000 --production-origin https://example.com
```

localseo will check those links on your local server. It will not scan the public site.

The package is on [npm](https://www.npmjs.com/package/localseo). The current release is 0.1.1. Review its results before you change your site.

## Read the report

Open `localseo-report/report.html` in your browser. You can search problems, filter results, and view each page. The page view compares the HTML from the server with the page after JavaScript runs. It also shows social image previews when they are available.

The report works offline. It does not load files from other sites. You can download its JSON data or copy a short summary. If copying is blocked by your browser, the report offers a text file instead.

Each run saves these files:

| File          | Contents                               |
| ------------- | -------------------------------------- |
| `report.html` | Report you can open in a browser       |
| `report.json` | All results for use in other tools     |
| `issues.csv`  | Failed checks for use in a spreadsheet |
| `summary.md`  | A short text report                    |

A new run replaces the files in the chosen output folder. Save a copy first if you need the old results.

Each result has a rule name, page URL, check details, and a suggested fix. It also links to the rule's source. Schema results show the source block and the item being checked.

The result labels mean:

- `passed`: the check ran and passed.
- `failed`: the check ran and found a problem.
- `skipped`: the check did not run or did not apply.
- `inconclusive`: the tool could not give a clear answer.

Errors are technical problems. Warnings need a closer look. Info results are notes or suggestions. The `confidence` field tells you whether a result was seen directly, is a possible problem, or still needs a check.

## What it checks

localseo checks page responses, redirects, `robots.txt`, sitemaps and indexing tags. It also checks titles, descriptions, canonical links, headings, image alt text, internal links and language tags.

Browser checks compare mobile and desktop pages. They look for content that appears after scrolling, broken files, and wrong file types. Separate requests check how the server responds to Googlebot and social bot names.

Other checks find similar page text, pages that are hard to reach, filter URLs that may keep growing, and problems with numbered pages. You can also compare the scan with route files from a Next.js build.

The [rule guide](docs/rules.md) lists the checks and their limits.

### Schema data

Schema data describes page content for search engines. localseo reads JSON-LD, Microdata and RDFa. It checks types, fields, links between items, dates, prices and ratings. It uses a local copy of Schema.org data, so it can run without an online schema service.

There are extra checks for Article, Product/Offer, ProductGroup, Course list, VacationRental, BreadcrumbList, Organization, LocalBusiness, Event, Recipe, VideoObject, FAQPage and JobPosting.

These checks cover part of Google's rules. Some parts still need a person to review them:

- Product checks include basic shop prices and currency. Shipping, returns and loyalty plans are not fully checked.
- ProductGroup checks IDs and fields used to describe product options, such as size or colour.
- Course list checks fields and list structure. Courses spread across several pages need more review.
- VacationRental checks guest counts, image counts and location numbers. It cannot judge what the photos show.
- VideoObject checks basic fields and media URLs. Clip, BroadcastEvent and SeekToAction are not covered.
- FAQPage still has Schema.org checks. Google ended FAQ rich results in May 2026.

The tool cannot judge whether claims, reviews or images are true and useful. It also cannot decide if Google will show a rich result. Those parts stay marked `inconclusive`.

The tool does not download extra JSON-LD contexts or items from other sites. If a check needs them, the report says so. Each report records the rule version and the version of the local schema data.

## SEO Score

The report shows a score from 0 to 100:

- 0 to 49: poor, shown in red.
- 50 to 89: needs work, shown in yellow.
- 90 to 100: good, shown in green.

Open "How it's calculated" to see the scores for each group of checks. The terminal, JSON file and text summary also show the score.

The score uses passed and failed error or warning checks that the tool can confirm. It leaves out info results, possible problems, social sharing checks, and checks you have chosen to ignore. Skipped checks and unclear results do not count as passes.

The calculation works like this:

1. Count each rule once per page and group. If it has both a pass and a failure, use the failure. This stops repeated schema items or two HTML views from adding extra points.
2. For each rule, find the share of checked pages that passed.
3. Within each group, give error rules a weight of 3 and warning rules a weight of 1.
4. Round each group score, then take the average of the groups and round it.

If there are no results that can count, the report shows no number. A score is marked `provisional` when the scan is incomplete or some relevant checks were skipped or unclear. This means you need more checks before you use the score.

Only compare scores from runs with the same rules and settings. The score does not predict your position in Google. It does not measure writing quality, site reputation or real users' page speed.

## Common commands

```bash
# Add a page that has no links pointing to it
npx localseo http://localhost:3000 --urls /products/widget

# Wait for a page element before reading the browser page
npx localseo http://localhost:3000 --wait-selector main

# Check pages even if robots.txt blocks them
npx localseo http://localhost:3000 --ignore-robots

# Allow a local HTTPS certificate that is not trusted
npx localseo https://localhost:3000 --insecure

# Check speed with Lighthouse on two pages
npx localseo http://localhost:3000 --lighthouse --lighthouse-pages 2

# Check one URL with a query string
npx localseo http://localhost:3000 --urls '/search?q=example'

# Skip the browser and save the report in another folder
npx localseo http://localhost:3000 --render off --output audit-results

# Compare with a saved report outside the output folder
npx localseo http://localhost:3000 --baseline previous/report.json

# Test made-up URLs to check the site's missing-page response
npx localseo http://localhost:3000 --probe404

# Raise the limits for extra checks and read Next.js build routes
npx localseo http://localhost:3000 --advanced-pages 100 --asset-limit 300 --project-dir ../my-next-site

# Skip extra mobile, bot and media checks
npx localseo http://localhost:3000 --no-advanced
```

The comparison with an old report lists new problems, old problems that remain, and problems no longer found. A problem may disappear because a page was not checked this time. If the settings or rule version differ, or either scan is incomplete, the report warns you about the comparison.

## Scan limits

| Setting                        | Default                            |
| ------------------------------ | ---------------------------------- |
| Pages                          | 500                                |
| Link depth during discovery    | 20                                 |
| HTTP requests at the same time | 5                                  |
| Browser pages at the same time | 2                                  |
| Request or page-load timeout   | 30 seconds                         |
| Wait for page changes to stop  | 500 ms                             |
| Sitemap files                  | 50                                 |
| Response size limit            | 8 MiB                              |
| Extra mobile and bot checks    | First 20 successful HTML pages     |
| Extra file checks              | 50 URL/type pairs on the same site |
| Lighthouse pages               | Up to 5                            |
| Query-string discovery         | Off, except URLs you add           |
| Exit on a failed check         | Errors                             |

The scan follows links in server HTML and browser pages. It also reads sitemaps, including gzip files, and checks canonical and language-link targets. These targets use the same page limits and blocked-path rules. Add hidden or unlinked pages with `--urls`.

URL fragments such as `#about` do not create extra pages in the scan. Letter case, ending slashes and query strings are kept. The tool never submits forms or clicks buttons.

The main browser check waits for text, tags and links to stop changing. Style animations do not restart this wait. The waiting limit is the larger of five seconds or twice the quiet period, up to the request timeout. A page that keeps changing makes the scan incomplete. For content that appears later, use `--wait-selector` to wait for an element you know will be ready.

Extra mobile and desktop checks wait for page load, your chosen element, and up to two seconds of the set wait time. Scroll checks move down by one screen height six times. Content beyond that may be missed.

The main browser scan may load files from other sites. Extra browser checks block those files, so missing outside scripts can affect their results. Login headers are sent only to the local site. Supplied header values are hidden in reports.

Extra checks follow `robots.txt` and your excluded paths, including redirects. When a page or file limit is reached, the report marks the scan incomplete. With `--render off`, browser-only checks are skipped. Missing Chromium gives an error with setup steps.

Image downloads stop at 8 MiB. Larger images and unsupported formats may stay unchecked. Video and PDF bodies are not downloaded, so their full size is not measured. Bot checks only change the user-agent name. They cannot show exactly what a real Googlebot visit would do.

Lighthouse is optional. You can leave it out with `npm install --omit=optional`. Its speed results come from a local test with Lighthouse's default device and network settings. Real users may get different results.

## Settings

localseo reads `localseo.config.json` from the current folder. Use `--config` to choose another file. Command options take priority over file settings. Unknown options and invalid values cause an error.

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
      "reason": "This page does not need a description"
    }
  ]
}
```

In a path pattern, `*` matches within one path part. `**` can match across slashes. A suppressed check stays in the report, but does not affect the score or the failed-check exit code.

You can repeat `--urls`, `--exclude`, `--header` and `--lighthouse-urls`. Keep secret headers out of Git. `--baseline` is only a command option, so do not put it in the settings file.

Exit codes help scripts decide what to do next:

- `0`: the scan finished with no problems at the chosen failure level.
- `1`: at least one result reached that failure level.
- `2`: the scan was incomplete or could not run.

`--fail-on none` turns off code `1`. An incomplete scan can still return `2`. Pages blocked by robots rules or excluded by your settings are outside the chosen scan.

## JavaScript API

```js
import { audit, writeReport, exitCode } from "localseo";

const report = await audit({ url: "http://localhost:3000" });
await writeReport(report);
process.exitCode = exitCode(report);
```

The package includes TypeScript types. The JSON report format is version `1`. New fields may be added within this format version. During the 0.x releases, the API may change between minor versions.

## Other ways to install

To use the GitHub release:

```bash
npm install -g https://github.com/eteriall/localseo/releases/download/v0.1.1/localseo-0.1.1.tgz
localseo setup
localseo http://localhost:3000
```

To build from source:

```bash
git clone https://github.com/eteriall/localseo.git
cd localseo
npm install
npm run build
node dist/cli.js setup
node dist/cli.js http://localhost:3000
```

## Work on the code

Run setup first, then:

```bash
npm run check
npm test
npm run build
npm pack
```

Tests use local test sites, Chromium and Lighthouse. Installing packages and the browser needs internet access. Schema checks run without an online validator.

The source code uses the MIT licence. The Schema.org files have their own [licence notes](data/NOTICE.md).

Report bugs or suggest checks in [GitHub Issues](https://github.com/eteriall/localseo/issues). Do not post passwords, secret headers or private website reports.
