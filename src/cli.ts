#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readConfig } from "./config.js";
import { readFile } from "node:fs/promises";
import { compareReports } from "./compare.js";
import { audit, writeReport, exitCode } from "./index.js";
import { redact, headerSecrets } from "./report.js";
import type { Options } from "./types.js";
const program = new Command()
  .name("localseo")
  .description("Evidence-based predeployment SEO audits")
  .version("0.1.0");
program
  .command("setup")
  .description("Install the Chromium browser used for rendering and Lighthouse")
  .action(async () => {
    const require = createRequire(import.meta.url);
    const cli = join(
      dirname(require.resolve("playwright/package.json")),
      "cli.js",
    );
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "install", "chromium"], {
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 2));
    });
  });
const number = (s: string) => Number(s);
const collect = (s: string, previous: string[] = []) => [...previous, s];
program
  .argument("[url]", "HTTP(S) URL to audit")
  .option("--config <path>", "Configuration file")
  .option("--production-origin <origin>", "Intended public origin")
  .option("--render <mode>", "both (default) or off")
  .option("--max-pages <number>", "Page budget", number)
  .option("--max-depth <number>", "Discovery depth", number)
  .option("--concurrency <number>", "HTTP concurrency", number)
  .option("--browser-concurrency <number>", "Browser concurrency", number)
  .option("--timeout <ms>", "Request/navigation timeout", number)
  .option("--settle <ms>", "Bounded browser settling period", number)
  .option("--wait-selector <selector>", "Wait for content selector")
  .option("--urls <path>", "Additional route seed (repeatable)", collect)
  .option("--exclude <glob>", "Exclude URL/path glob (repeatable)", collect)
  .option("--include-query", "Discover query URLs")
  .option("--ignore-robots", "Audit routes disallowed in robots.txt")
  .option("--probe404", "Probe one random nonexistent path for soft-404 risk")
  .option("--no-advanced", "Disable additional browser and asset probes")
  .option(
    "--advanced-pages <number>",
    "Mobile, bot and lazy-content page budget (default 20)",
    number,
  )
  .option(
    "--asset-limit <number>",
    "Additional same-origin asset budget (default 50)",
    number,
  )
  .option(
    "--project-dir <directory>",
    "Read Next.js build manifests or static export routes",
  )
  .option("--insecure", "Accept self-signed TLS certificates")
  .option(
    "--header <header>",
    "Request header, Name: value (repeatable)",
    collect,
  )
  .option("--output <directory>", "Report output directory")
  .option("--baseline <file>", "Compare findings with an earlier report.json")
  .option("--fail-on <severity>", "error, warning, info, or none")
  .option("--lighthouse", "Measure performance with Lighthouse")
  .option("--lighthouse-pages <number>", "Lighthouse page budget", number)
  .option(
    "--lighthouse-urls <path>",
    "Explicit Lighthouse URL (repeatable)",
    collect,
  )
  .action(async (url: string | undefined, flags: any, command: Command) => {
    const { config, header, baseline, ...cli } = flags;
    if (command.getOptionValueSource("advanced") === "default")
      delete cli.advanced;
    const file = await readConfig(config ?? "localseo.config.json", !!config);
    const headers = { ...file.headers };
    for (const h of header ?? []) {
      const pos = h.indexOf(":");
      if (pos <= 0) throw new Error("Headers must use Name: value");
      headers[h.slice(0, pos).trim()] = h.slice(pos + 1).trim();
    }
    const options = {
      ...file,
      ...cli,
      ...(url ? { url } : {}),
      headers,
    } as Partial<Options>;
    const report = await audit(options, (message) => {
      if (process.stderr.isTTY)
        process.stderr.write(redact(message, headerSecrets(headers)) + "\n");
    });
    if (baseline) {
      const previous = JSON.parse(await readFile(baseline, "utf8"));
      if (
        previous.version !== "1" ||
        !Array.isArray(previous.checks) ||
        !previous.settings ||
        !previous.coverage
      )
        throw new Error("Baseline must be a localseo report.json");
      report.comparison = compareReports(report, previous);
      console.log(
        `Changes: ${report.comparison.added.length} new · ${report.comparison.resolved.length} disappeared · ${report.comparison.persisting.length} persisting`,
      );
      if (!report.comparison.comparable) console.log(report.comparison.note);
    }
    const output = await writeReport(report);
    const priority = { error: 0, warning: 1, info: 2 };
    const failures = report.checks
      .filter((c) => c.outcome === "failed" && !c.suppression)
      .sort((a, b) => priority[a.severity] - priority[b.severity]);
    console.log(
      `localseo · ${report.coverage.scanned} pages · ${failures.filter((c) => c.severity === "error").length} errors · ${failures.filter((c) => c.severity === "warning").length} warnings`,
    );
    if (!report.coverage.complete)
      console.log("PARTIAL: " + report.coverage.reasons.join("; "));
    if (report.score)
      console.log(
        `SEO Score: ${report.score.value ?? "—"}/100${report.score.provisional ? " · provisional" : ""} · technical audit, not a ranking prediction`,
      );
    const groups = new Map<string, typeof failures>();
    for (const c of failures.filter((c) => c.severity !== "info")) {
      const key = `${c.severity}:${c.rule}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const list of [...groups.values()].slice(0, 12)) {
      const c = list[0],
        urls = [...new Set(list.map((c) => c.url))];
      console.log(
        `${c.severity.toUpperCase()} ${c.rule} · ${urls.length} URL${urls.length === 1 ? "" : "s"}\n  ${c.remediation}\n  ${urls.slice(0, 2).join("\n  ")}${urls.length > 2 ? `\n  + ${urls.length - 2} more in report` : ""}`,
      );
    }
    if (groups.size > 12)
      console.log(`+ ${groups.size - 12} more issue groups in report`);
    console.log(
      `Reports: ${output}/report.html · report.json · issues.csv · summary.md`,
    );
    process.exitCode = exitCode(report);
  });
program.parseAsync().catch((e) => {
  console.error(`localseo: ${(e as Error).message}`);
  process.exitCode = 2;
});
