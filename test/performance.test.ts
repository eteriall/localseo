import { it, expect } from "vitest";
import { audit } from "../src/index.js";
import { fixture } from "./fixtures.js";
it("runs real Lighthouse performance measurements on a supplied local page", async () => {
  const site = await fixture();
  try {
    const report = await audit({
      url: site.origin + "/static",
      render: "off",
      maxPages: 1,
      lighthouse: true,
      lighthousePages: 1,
      lighthouseUrls: ["/static"],
      timeout: 30000,
    });
    expect(report.lighthouse).toHaveLength(1);
    expect(report.lighthouse[0].error).toBeUndefined();
    expect(report.lighthouse[0].scores?.performance).toBeTypeOf("number");
    expect(
      (report.lighthouse[0].metrics?.["largest-contentful-paint"] as any).value,
    ).toBeGreaterThan(0);
  } finally {
    await site.close();
  }
}, 60000);
