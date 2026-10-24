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
      `connect-src 'self' ${process.env.NEXT_PUBLIC_NIHO_WEB_ORIGIN ?? "https://niho.life"} https://gateway.umami.is`,
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

const nextConfig: NextConfig = {
  // Self-contained server for the container image (docs/adr/0001-web-stack.md).
  output: "standalone",
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
