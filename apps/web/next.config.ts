import path from "node:path";
import type { NextConfig } from "next";

// Headers here are fixed at build time. Anything that differs per environment
// (indexing, host sign-up, API mode) is read at request time in src/lib/config.ts,
// so one reviewed image can be promoted from preview to production.

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Keeps booking URLs out of the Referer sent to Stripe or other sites.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "img-src 'self' data: https:",
      `media-src 'self' ${process.env.NEXT_PUBLIC_NIHO_WEB_ORIGIN ?? "https://niho.life"}`,
      "font-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // Next.js inlines its bootstrap script. A nonce-based policy is planned with #12/#15.
      `script-src 'self' 'unsafe-inline' https://cloud.umami.is${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      `connect-src 'self' ${process.env.NEXT_PUBLIC_NIHO_WEB_ORIGIN ?? "https://niho.life"} https://gateway.umami.is https://storage.googleapis.com`,
      "frame-src https://www.youtube-nocookie.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://checkout.stripe.com",
    ].join("; "),
  },
];

/** Pages that carry booking input or personal results: never cached, never indexed. */
const privatePageHeaders = [
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/**
 * Host console (#86): private like the booking pages. `same-origin` replaces
 * `no-referrer` so the console's own POSTs carry a real Origin header (with
 * no-referrer, browsers send `Origin: null` and the same-origin check would fail).
 * Other sites still get no Referer.
 */
const hostConsoleHeaders = [...privatePageHeaders, { key: "Referrer-Policy", value: "same-origin" }];

/**
 * Crawlers that read `<head>` from the first HTML bytes and never run JavaScript.
 * Next streams metadata after the shell (so `title`, canonical and `robots` land after `</head>`)
 * for every other User-Agent; these get blocking metadata instead (#139).
 * Setting this option replaces Next's default list (node_modules/next/dist/shared/lib/router/utils/html-bots.js),
 * so that list is repeated first. The generic `bot|crawl|spider` tail catches crawlers not named here.
 */
export const HTML_LIMITED_BOTS = new RegExp(
  [
    // Next's default list
    "[\\w-]+-Google", "Google-[\\w-]+", "Chrome-Lighthouse", "Slurp", "DuckDuckBot", "baiduspider", "yandex", "sogou", "bitlybot",
    "tumblr", "vkShare", "quora link preview", "redditbot", "ia_archiver", "Bingbot", "BingPreview", "applebot", "facebookexternalhit",
    "facebookcatalog", "Twitterbot", "LinkedInBot", "Slackbot", "Discordbot", "WhatsApp", "SkypeUriPreview", "Yeti", "googleweblight",
    // Search engines and AI crawlers or fetchers that did not match it
    "Googlebot", "GoogleOther", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "Claude-Web",
    "anthropic-ai", "PerplexityBot", "Perplexity-User", "CCBot", "Amazonbot", "Bytespider", "meta-external", "cohere-ai", "DuckAssistBot",
    "MistralAI-User", "YouBot", "Diffbot", "PetalBot",
    "bot", "crawl", "spider",
  ].join("|"),
  "i",
);

const nextConfig: NextConfig = {
  // Self-contained server for the container image (docs/adr/0001-web-stack.md).
  output: "standalone",
  htmlLimitedBots: HTML_LIMITED_BOTS,
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@niho-experience/api-client"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/experiences/:slug/book", headers: privatePageHeaders },
      { source: "/ja/experiences/:slug/book", headers: privatePageHeaders },
      { source: "/booking/:path*", headers: privatePageHeaders },
      { source: "/ja/booking/:path*", headers: privatePageHeaders },
      { source: "/preview/:path*", headers: privatePageHeaders },
      // `:path+` leaves /host itself (the public introduction) indexable.
      { source: "/host/:path+", headers: hostConsoleHeaders },
      // The whole admin surface is private, including its entrance. Keep root and children
      // explicit so changes in path-pattern handling cannot accidentally leave /admin public.
      { source: "/admin", headers: hostConsoleHeaders },
      { source: "/admin/:path+", headers: hostConsoleHeaders },
    ];
  },
};

export default nextConfig;
