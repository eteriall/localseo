import { readFile } from "node:fs/promises";
import type { Options } from "./types.js";
export const defaults: Omit<Options, "url"> = {
  render: "both",
  maxPages: 500,
  maxDepth: 20,
  concurrency: 5,
  browserConcurrency: 2,
  timeout: 30000,
  settle: 500,
  includeQuery: false,
  ignoreRobots: false,
  probe404: false,
  advanced: true,
  advancedPages: 20,
  assetLimit: 50,
  insecure: false,
  urls: [],
  exclude: [],
  headers: {},
  output: "localseo-report",
  failOn: "error",
  lighthouse: false,
  lighthousePages: 5,
  lighthouseUrls: [],
  severityOverrides: {},
  suppressions: [],
};
export function validateOptions(input: Partial<Options>): Options {
  for (const key of Object.keys(input))
    if (
      !(key in defaults) &&
      !["url", "productionOrigin", "waitSelector", "projectDir"].includes(key)
    )
      throw new Error(`Unknown configuration option: ${key}`);
  const o = { ...defaults, ...input } as Options;
  if (!o.url)
    throw new Error("Supply a URL, for example http://localhost:3000");
  for (const key of ["url", "productionOrigin"] as const) {
    if (!o[key]) continue;
    const u = new URL(o[key]!);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw new Error(
        `${key} must be HTTP(S), without credentials; use headers for authentication`,
      );
    if (
      key === "productionOrigin" &&
      (u.pathname !== "/" || u.search || u.hash)
    )
      throw new Error("productionOrigin must contain only scheme and host");
    o[key] = key === "productionOrigin" ? u.origin : u.href;
  }
  for (const key of [
    "maxPages",
    "maxDepth",
    "concurrency",
    "browserConcurrency",
    "timeout",
    "settle",
    "lighthousePages",
    "advancedPages",
    "assetLimit",
  ] as const) {
    if (
      !Number.isSafeInteger(o[key]) ||
      o[key] < (["maxDepth", "settle"].includes(key) ? 0 : 1)
    )
      throw new Error(
        `${key} must be a ${["maxDepth", "settle"].includes(key) ? "nonnegative" : "positive"} integer`,
      );
  }
  for (const key of [
    "includeQuery",
    "ignoreRobots",
    "probe404",
    "insecure",
    "lighthouse",
    "advanced",
  ] as const)
    if (typeof o[key] !== "boolean") throw new Error(`${key} must be boolean`);
  for (const key of ["urls", "exclude", "lighthouseUrls"] as const)
    if (!Array.isArray(o[key]) || o[key].some((v) => typeof v !== "string"))
      throw new Error(`${key} must be an array of strings`);
  if (
    !["both", "off"].includes(o.render) ||
    !["error", "warning", "info", "none"].includes(o.failOn)
  )
    throw new Error("Invalid render or failOn option");
  if (
    !o.headers ||
    typeof o.headers !== "object" ||
    Object.values(o.headers).some((v) => typeof v !== "string")
  )
    throw new Error("headers must be a string map");
  if (
    Array.isArray(o.headers) ||
    Object.entries(o.headers).some(
      ([k, v]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || /[\r\n]/.test(v),
    )
  )
    throw new Error("Invalid HTTP header");
  if (typeof o.output !== "string" || !o.output.trim())
    throw new Error("output must be a nonempty path");
  if (o.waitSelector !== undefined && typeof o.waitSelector !== "string")
    throw new Error("waitSelector must be a string");
  if (
    o.projectDir !== undefined &&
    (typeof o.projectDir !== "string" || !o.projectDir.trim())
  )
    throw new Error("projectDir must be a nonempty path");
  if (
    !o.severityOverrides ||
    Object.values(o.severityOverrides).some(
      (v) => !["error", "warning", "info"].includes(v),
    )
  )
    throw new Error("Invalid severityOverrides");
  if (
    !Array.isArray(o.suppressions) ||
    o.suppressions.some((s) => !s.rule || !s.urlPattern || !s.reason?.trim())
  )
    throw new Error("Each suppression needs rule, urlPattern and reason");
  return o;
}
export async function readConfig(
  file: string,
  explicit = false,
): Promise<Partial<Options>> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (!explicit && (e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
export function glob(value: string, pattern: string): boolean {
  return new RegExp(
    "^" +
      pattern
        .split("**")
        .map((part) =>
          part
            .split("*")
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*"),
        )
        .join(".*") +
      "$",
  ).test(value);
}
