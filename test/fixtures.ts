import { createServer, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
export const html = (body = "", head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture page title</title><meta name="description" content="A fixture description.">${head}</head><body><h1>Fixture heading</h1>${body}</body></html>`;
export async function fixture() {
  const requests: { url: string; authorization?: string }[] = [];
  let origin = "";
  const server = createServer((req, res) => {
    const path = req.url!;
    requests.push({ url: path, authorization: req.headers.authorization });
    const send = (value: string, status = 200, type = "text/html") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(value);
    };
    if (path === "/robots.txt")
      return send(
        `User-agent: *\nDisallow: /blocked\nAllow: /blocked/open\nSitemap: ${origin}/map-index.xml`,
        200,
        "text/plain",
      );
    if (path === "/sitemap.xml") return send("missing", 404, "text/plain");
    if (path === "/client-redirect")
      return send(
        html('<script>setTimeout(()=>location.href="/static",50)</script>'),
      );
    if (path === "/cancelled-fetch")
      return send(
        html(
          '<script>const c=new AbortController();fetch("/slow",{signal:c.signal}).catch(()=>{});setTimeout(()=>c.abort(),50)</script>',
        ),
      );
    if (path === "/slow") return;
    if (path === "/compressed.xml.gz") {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      return res.end(
        gzipSync("<urlset><url><loc>https://example.org/</loc></url></urlset>"),
      );
    }
    if (path === "/redirect-blocked") {
      res.writeHead(302, { Location: "/blocked" });
      return res.end();
    }
    if (path === "/delayed")
      return send(
        html(
          '<script>setTimeout(()=>{document.title="Settled title"},200)</script>',
        ),
      );
    if (path === "/resources")
      return send(html('<img src="/missing" alt="Test image">'));
    if (path === "/map-index.xml")
      return send(
        `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/map.xml</loc></sitemap></sitemapindex>`,
        200,
        "application/xml",
      );
    if (path === "/map.xml")
      return send(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/orphan", "/noindex", "/blocked"].map((p) => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>`,
        200,
        "application/xml",
      );
    if (path === "/")
      return send(
        html(
          '<nav><a href="/static">Static</a></nav><a href="/client">Client</a><a href="/redirect">Redirect</a><a href="/missing">Broken</a><a href="/query?x=1">Query</a><a href="/blocked">Blocked</a><a href="/loop-a">Loop</a><img src="/image.png" alt=""><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture","url":"' +
            origin +
            '"}</script>',
        ),
      );
    if (path === "/client")
      return send(
        html(
          '<div id="content"></div><script>document.title="Rendered title";document.getElementById("content").innerHTML=\'<a href="/js-only">JS link</a><p>Client-only content</p>\';</script>',
        ),
      );
    if (path === "/noindex") {
      res.setHeader("X-Robots-Tag", "noindex");
      return send(html("Not indexed"));
    }
    if (path === "/redirect") {
      res.writeHead(301, { Location: "/static" });
      return res.end();
    }
    if (path === "/loop-a" || path === "/loop-b") {
      res.writeHead(302, {
        Location: path === "/loop-a" ? "/loop-b" : "/loop-a",
      });
      return res.end();
    }
    if (path === "/external") {
      res.writeHead(302, { Location: "https://example.org/private" });
      return res.end();
    }
    if (path === "/missing") return send(html("Not found"), 404);
    if (path === "/image.png") return send("", 200, "image/png");
    if (path === "/stream") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<!doctype html><html><head></head><body><h1>Streamed</h1>");
      setTimeout(
        () =>
          res.end(
            '<title>Streamed title</title><meta name="description" content="Late metadata"></body></html>',
          ),
        30,
      );
      return;
    }
    send(html(`<p>${path}</p>`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
