import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPilotExperiences,
  PILOT_COMMUNITY_DINNER_PHOTO_PATH,
  PILOT_SAMPLE_PHOTO_PATH,
} from "@niho-experience/api-client/mock";
import { SAMPLE_MEDIA, siteMediaFiles } from "./site-media";

const publicDir = join(__dirname, "../../public");
const credits = readFileSync(join(publicDir, "sample/CREDITS.md"), "utf8");

describe("provisional media", () => {
  it("is flagged as provisional media until the reshoot replaces it", () => {
    expect(SAMPLE_MEDIA).toBe(true);
  });

  it("uses only files that exist in public/sample and have a source in CREDITS.md", () => {
    for (const file of siteMediaFiles()) {
      expect(file.startsWith("/sample/")).toBe(true);
      expect(existsSync(join(publicDir, file)), file).toBe(true);
      // Posters share the clip's name; the credit is listed for the .mp4.
      expect(credits, file).toContain(basename(file).replace(/\.jpg$/, file.includes("/video/") ? ".mp4" : ".jpg"));
    }
  });

  it("serves every pilot sample photo from public/sample with a credit", () => {
    const urls = buildPilotExperiences()
      .flatMap((experience) => [experience.cover, ...experience.photos, ...experience.hosts.map((host) => host.avatar)])
      .filter((image) => image !== null)
      .map((image) => image.url)
      .filter((url) => url.startsWith(`${PILOT_SAMPLE_PHOTO_PATH}/`));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(existsSync(join(publicDir, url)), url).toBe(true);
      expect(credits, url).toContain(basename(url));
    }
  });

  it("uses the owner-approved P-01 gallery locally and keeps meeting details private", () => {
    const dinner = buildPilotExperiences().find((experience) => experience.slug === "kamakura-community-dinner");
    expect(dinner).toBeDefined();
    expect(dinner?.photos).toHaveLength(7);
    for (const image of dinner?.photos ?? []) {
      expect(image.url.startsWith(`${PILOT_COMMUNITY_DINNER_PHOTO_PATH}/`)).toBe(true);
      expect(existsSync(join(publicDir, image.url)), image.url).toBe(true);
    }
    expect(dinner?.meetingPointDisclosure).toBe("AFTER_BOOKING");
    expect(dinner?.meetingPoint).toBeNull();
  });
});
