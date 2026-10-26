import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { publicVideoProblems, videoForExperience } from "@/lib/videos";
import { YouTubeVideo } from "./YouTubeVideo";

describe("public video gate", () => {
  it("keeps unpublished experiences video-free and rejects unsafe IDs", () => {
    expect(videoForExperience("kamakura-community-dinner")).toBeNull();
    expect(publicVideoProblems({ youtubeId: "bad?autoplay=1", caption: "Host" })).not.toEqual([]);
    expect(publicVideoProblems({ youtubeId: "abcDEF123_-", caption: "Host" })).toEqual([]);
  });

  it("sends only the poster before play, with a narrow iframe CSP", async () => {
    const html = renderToStaticMarkup(createElement(YouTubeVideo, {
      video: { youtubeId: "abcDEF123_-", caption: "A host's introduction" },
      poster: "/guides/approved-poster.jpg",
      title: "Kamakura dinner",
    }));
    expect(html).toContain("Play video: A host&#x27;s introduction");
    expect(html).toContain("/guides/approved-poster.jpg");
    expect(html).not.toMatch(/<iframe|youtube(?:-nocookie)?\.com/);
    const headers = await nextConfig.headers!();
    const csp = headers.find((rule) => rule.source === "/:path*")?.headers.find((header) => header.key === "Content-Security-Policy")?.value;
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com");
    expect(csp).not.toMatch(/(?:script|connect|media)-src[^;]*youtube/);
  });
});
