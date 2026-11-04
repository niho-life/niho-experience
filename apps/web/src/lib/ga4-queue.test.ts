import { describe, expect, it } from "vitest";
import { createGtagQueue } from "./ga4-queue";

describe("GA4 dataLayer queue", () => {
  it("pushes the gtag call's arguments object", () => {
    const dataLayer: unknown[] = [];
    const gtag = createGtagQueue(dataLayer);
    const command = ["event", "page_view", { page_location: "https://experience.niho.life/" }];

    gtag(...command);

    expect(dataLayer).toHaveLength(1);
    expect(Array.isArray(dataLayer[0])).toBe(false);
    expect(Object.prototype.toString.call(dataLayer[0])).toBe("[object Arguments]");
    expect(Array.from(dataLayer[0] as IArguments)).toEqual(command);
  });
});
