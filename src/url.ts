import type { Options } from "./types.js";
export function normalize(value: string, base?: string): string | undefined {
  try {
    const u = new URL(value, base);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      return;
    u.hash = "";
    return u.href;
  } catch {
    return;
  }
}
export function localUrl(
  value: string,
  o: Options,
  base = o.url,
): string | undefined {
  const s = normalize(value, base);
  if (!s) return;
  const u = new URL(s);
  const origin = new URL(o.url).origin;
  if (o.productionOrigin && u.origin === o.productionOrigin) {
    const mapped = new URL(origin);
    u.protocol = mapped.protocol;
    u.host = mapped.host;
  }
  return u.origin === origin ? u.href : undefined;
}
export function publicUrl(value: string, o: Options): string {
  const u = new URL(value);
  if (o.productionOrigin && u.origin === new URL(o.url).origin)
    return o.productionOrigin + u.pathname + u.search;
  return u.href;
}
