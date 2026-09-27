# Check rules

Each result has a rule ID, such as `title.present`. You can use these IDs to find results or change their level in the settings file.

Some rules confirm a problem. Others point to something you should review. The report shows the difference. Check details may include a URL, a server response, a page tag or part of the page text.

## Page checks

| Rule group                 | What it checks                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| `http.*`                   | Page responses, redirect chains, redirect loops and HTML file types     |
| `robots.*`                 | robots.txt, blocked pages and indexing rules                            |
| `sitemap.*`                | Sitemap format, URLs, dates and page access                             |
| `index.*`                  | General and Googlebot indexing rules, including rules that conflict     |
| `title.*`, `description.*` | Missing tags, extra tags and repeated text across pages                 |
| `canonical.*`              | Canonical links, their targets and loops                                |
| `heading.*`                | Main headings and gaps between heading levels                           |
| `html.*`                   | Page language, viewport, text encoding, head structure and meta refresh |
| `image.alt`                | Missing image alt text                                                  |
| `links.*`                  | Internal links, redirects, labels and steps needed to reach pages       |
| `hreflang.*`               | Language tags, linked pages and return links                            |
| `discovery.orphan`         | Pages found in the sitemap with no known page links                     |
| `render.*`                 | Browser errors and changes after JavaScript runs                        |
| `social.*`                 | Sharing tags and images                                                 |
| `schema.*`                 | Schema format, types, fields and links between items                    |
| `schema.google.<Type>.*`   | Extra rules for supported Google result types                           |

A linked page must be visited before its status can be checked. If it was not visited, the tool leaves the result unclear. You can raise the scan limit or add the URL yourself.

A page found only in a sitemap may have no incoming links. It may also have links on pages outside the scan. Review the result before you call the page an orphan.

A canonical link names the preferred URL for a page. It may point to another URL. Sitemaps should list preferred pages that can be indexed. A page with `noindex` can still use its own canonical link, but it should stay out of the sitemap.

The tool accepts empty alt text for decorative images. It does not treat several H1 headings, short text, or chosen `noindex` tags as errors on their own.

## Page and browser details

- `page.seo-applicability` skips normal page tags and schema checks on failed page responses. HTTP and sitemap problems still appear.
- `render.resources` shows image, script, style or API requests that failed in Chromium. It needs browser mode.
- `render.stability` checks whether page content stopped changing during the set wait time. If it kept changing, the result is unclear.
- `links.labels` checks link text and href values. It includes a short HTML sample. A link used as a button may need a manual check.
- `metadata.local-urls` finds local URLs in canonical, language or sharing tags when you have set a public domain.
- `hreflang.self` checks whether language tags include the current page.
- `hreflang.conflicts` finds several targets for the same language.
- `content.duplicate` finds pages with the same main text. It checks successful, indexable pages with at least 200 characters. It leaves out navigation, headers and footers.
- `social.canonical` compares the Open Graph URL with the canonical URL.
- `sitemap.lastmod` checks date format and future dates. It cannot prove when a page last changed.
- `sitemap.duplicate` finds repeated sitemap URLs.

`--ignore-robots` lets the tool visit blocked pages. The report still shows that robots.txt blocks them.

The tool follows canonical and language-link targets within the scan limits. A chain that goes beyond those limits stays unclear. Root URLs that mean the same thing compare as equal.

Browser comparisons read the full server response, including streamed HTML. They then compare it with the page after JavaScript runs. These checks wait only for the set time and chosen page element. They cannot try every action a visitor might take.

JSON-LD comparisons ignore spaces and field order. They keep array order.

## Mobile pages and bot responses

`mobile.metadata` and `mobile.status` compare page tags and HTTP status on desktop and mobile. `mobile.content` and `mobile.links` compare main text and links. Text or link changes are review notes because mobile menus and changing content can cause valid differences.

`mobile.schema` compares JSON-LD. It does not compare all Microdata or RDFa forms.

`bots.google-response` checks the response to a Googlebot user-agent name. `bots.raw-parity` shows changes from the normal server HTML. `bots.raw-metadata` notes tags that may need JavaScript. Missing tags in server HTML alone do not prove that Google cannot read them.

`social.bot-response` and `social.bot-parity` check Twitterbot and Facebook responses. All bot checks read the full response. These requests come from localseo, not from the real bots.

Read Google's [mobile page guide](https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing).

## Content that loads later

`render.lazy-content` compares the page before and after six scroll steps. Text already in the DOM, such as a closed section, is kept in the first view.

`pagination.interaction` looks for buttons such as "Load more". The tool does not click them or submit forms. Check whether this content also has normal links that a crawler can follow.

Read Google's [lazy-loading guide](https://developers.google.com/search/docs/crawling-indexing/javascript/lazy-loading).

## File types and robots rules

`render.resource-mime` checks file types seen by the browser. `render.asset-mime` fetches local files and checks their status and type. For example, a server may return status 200 but send HTML for a JavaScript file.

`render.resources-robots` and `render.asset-robots` show files blocked for Googlebot. They keep this information even with `--ignore-robots`.

Extra file checks stay on the same site and use the file limit. Files on other sites are left unchecked.

## Head structure and response size

`html.head-structure` finds invalid elements before the closing head tag in the source HTML. It allows Next.js tags sent later in the body. It checks this part of the page, not every HTML rule.

`crawl.fetch-size` checks the size of the HTML after decoding. It flags HTML over Googlebot's 2 MB limit and looks for important tags beyond that point. The separate 64 MB PDF limit is not measured, because the PDF body is not downloaded.

Read Google's guides to [valid page metadata](https://developers.google.com/search/docs/crawling-indexing/valid-page-metadata) and [Googlebot file limits](https://developers.google.com/search/docs/crawling-indexing/googlebot).

## Missing pages

With `--probe404`, `http.unknown-route` requests one made-up path. A 404 or 410 response, or a page with noindex, passes this check. A 200 page, redirect or request error needs more review.

With extra checks on, `http.rendered-unknown-route` tests two more made-up paths. It checks the browser page for noindex and compares its main text with real pages.

A 200 response for a missing page may be a soft 404. Google's final choice cannot be tested locally.

## Links and numbered pages

`links.navigation-depth` finds the shortest known link path from the start URL. It also lists incoming links. This is separate from the depth used to discover sitemap pages. More than three clicks is a review point, not a Google limit.

`pagination.targets` checks visited next and previous page links. `pagination.canonical` looks for later numbered pages that point to another canonical URL. Different result pages usually need their own URLs. Review pages that are true copies before making a change.

The tool does not require `rel=next` or `rel=prev`. Read Google's [numbered-page guide](https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading).

`crawl.query-traps` flags ten or more query variants for one path. Filter menus can create very large groups of URLs. This rule uses links already found and does not fetch every possible combination.

## Build routes

Use `--project-dir` for `routes.manifest`. It compares scanned pages with these files:

- Next.js pages, app paths, prerender and routes JSON files.
- Static HTML pages in `out/**/*.html`.

The tool only reads these files. It does not run the project's source or settings code. API handlers and dynamic route templates are left out. Add real URLs for dynamic pages with `--urls`.

Build files may be old. A route missing from the scan is left unclear until you check it.

## Similar text

`content.near-duplicate` looks for very similar main text on indexable pages. It compares groups of four words with the Jaccard method: shared groups divided by all different groups.

The rule uses at least 85% similarity. Both texts need at least 200 characters, and the shorter text must be at least 70% as long as the other.

It compares the first 250 pages that meet these rules and the first 10,000 words of each text. The report shows matching URLs, a percentage and a short text sample. These results need review and do not lower the score. Reaching the page limit adds a note.

## Indexing and search snippets

`robots.noindex-blocked` finds a page with noindex that robots.txt also blocks. A crawler needs access to the page to read its noindex tag.

`robots.non-html` reads X-Robots-Tag on PDF responses. A PDF does not need noindex unless you want to keep it out of search. HTML meta tags do not control PDF indexing.

`robots.snippet-values` checks preview limits and the HTML elements allowed to use data-nosnippet. `robots.snippet-precedence` points out rules that overlap. Google follows the more restrictive rule.

Headers meant for another bot are kept separate from Googlebot rules. Read Google's [robots tag guide](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag).

## Images

`images.responsive-markup` checks the img fallback URL, sizes and width/height values. `images.srcset` checks the list of image choices and their size values.

`images.browser-decode` checks images loaded by the browser. `images.asset-decode` checks downloaded image data and reads its dimensions. Declared image choices and the browser's chosen currentSrc are checked within the file limit.

`images.pending` lists images still waiting to load. `images.background-content` lists CSS background images for review. Decorative backgrounds are fine. Important images may need an img element with alt text.

Unsupported images and files that did not load stay unchecked. Read Google's [image guide](https://developers.google.com/search/docs/appearance/google-images).

## Schema checks

JSON-LD, Microdata and RDFa are read into a shared item format. This lets the tool check types, fields and links between items. It can follow references across blocks on the same page. It does not fetch items from other sites.

Results show the data format and item ID. JSON-LD results also show the script number and line. General Schema.org field and type mismatches are warnings because the vocabulary allows flexible use.

`schema.visible-values` compares prices, ratings, dates and stock details with page text. A matching number may belong to a different item. Dates and prices may also use a local format. These results need manual review even when the text matches.

`schema.entity-conflict` shows several values that may conflict for one item. Several names in different languages, or other valid lists of values, are allowed. `schema.relationship-type` checks the type of an item used in a link, such as an author or a product group.

Google checks cover required and suggested fields for the types listed in the README. Passing these fields does not complete the manual checks. The tool cannot confirm truth, image relevance or Google's final decision.

`schema.google.MerchantListing.candidate` checks image, active price and currency. It is an info check because some product pages do not sell the product.

`schema.google.ProductGroup.*` checks group IDs and supported product options. `schema.google.Course.*` checks course fields and some list rules. `schema.google.VacationRental.*` checks guest counts, images and location values. The README explains which parts still need review.

Google breadcrumb URL values are accepted using the [official examples](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb).

Source guides: [schema rules](https://developers.google.com/search/docs/appearance/structured-data/sd-policies), [merchant listings](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing), [product options](https://developers.google.com/search/docs/appearance/structured-data/product-variants), [course lists](https://developers.google.com/search/docs/appearance/structured-data/course), and [holiday rentals](https://developers.google.com/search/docs/appearance/structured-data/vacation-rental).

## Video and sharing images

`video.playback` reads the HTML video URL, load errors and poster image. `schema.google.VideoObject.page-consistency` compares video schema URLs with the page. File checks also use schema thumbnail, content and embed URLs.

The tool cannot confirm full playback, autoplay or the contents of outside video players.

`social.image-decode`, `social.image-shape` and `social.image-mime` check social image data, file type, dimensions and shape. The page view can show a small local PNG preview. Sharing checks do not affect the SEO Score.

## Limits

These rules are version `2026-09-27.4`. The scan can only judge the pages and files it can reach within your limits. Unclear and skipped results are shown in the report.

The tool does not check live Google indexing or act as a real Googlebot. Source-file line numbers are only given for supported schema blocks. Google's full rich-result rules still need further review. See the README for the score formula and scan settings.
