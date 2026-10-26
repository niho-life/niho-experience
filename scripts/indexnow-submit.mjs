#!/usr/bin/env node
// IndexNow で公開ページの追加・更新を Bing などへ知らせる（#141）。手動で実行する。docs/seo.md の「IndexNow」を参照。
//
//   node scripts/indexnow-submit.mjs --dry-run                  # sitemap の全 URL。送らずに中身だけ表示
//   node scripts/indexnow-submit.mjs --since 2026-11-01         # sitemap の lastmod がこの日以降の URL だけ
//   node scripts/indexnow-submit.mjs https://experience.niho.life/experiences/some-slug
//
// 鍵はサイトの /indexnow-key.txt から読む（公開値。検索公開が止まっている間は 404 なので、送信もしない）。

const ENDPOINT = "https://api.indexnow.org/indexnow";
const KEY_PATH = "/indexnow-key.txt";
const MAX_URLS = 10_000;

function parseArgs(argv) {
  const options = { site: "https://experience.niho.life", since: null, dryRun: false, urls: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--site") options.site = argv[++i];
    else if (arg === "--since") options.since = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.urls.push(arg);
  }
  if (options.since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(options.since ?? "")) throw new Error("--since takes YYYY-MM-DD");
  options.site = new URL(options.site).origin;
  return options;
}

const decode = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** `<url>` entries of a urlset sitemap: its loc and (optional) lastmod. */
export function sitemapEntries(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, body]) => ({
    loc: decode(body.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1] ?? ""),
    lastmod: body.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1] ?? null,
  })).filter((entry) => entry.loc);
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "error", headers: { "User-Agent": "niho-experience-indexnow/1" } });
  return { status: response.status, text: await response.text() };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const host = new URL(options.site).host;

  const keyFile = await fetchText(`${options.site}${KEY_PATH}`);
  const key = keyFile.text.trim();
  if (keyFile.status !== 200 || !/^[A-Za-z0-9-]{8,128}$/.test(key)) {
    throw new Error(`${options.site}${KEY_PATH} returned ${keyFile.status}: search indexing is off or the key file is missing, so nothing is sent`);
  }

  let urls = options.urls;
  if (urls.length === 0) {
    const sitemap = await fetchText(`${options.site}/sitemap.xml`);
    if (sitemap.status !== 200) throw new Error(`sitemap.xml returned ${sitemap.status}`);
    urls = sitemapEntries(sitemap.text)
      .filter((entry) => options.since === null || (entry.lastmod !== null && entry.lastmod.slice(0, 10) >= options.since))
      .map((entry) => entry.loc);
  }
  const foreign = urls.filter((url) => new URL(url).host !== host);
  if (foreign.length) throw new Error(`URLs outside ${host}: ${foreign.join(", ")}`);
  if (urls.length === 0) throw new Error("no URLs to send");
  if (urls.length > MAX_URLS) throw new Error(`IndexNow takes up to ${MAX_URLS} URLs per request; got ${urls.length}`);

  const payload = { host, key, keyLocation: `${options.site}${KEY_PATH}`, urlList: [...new Set(urls)] };
  if (options.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) });
  // 200: accepted, 202: accepted while the key is being verified. Anything else is a failure (400/403/422/429).
  if (response.status !== 200 && response.status !== 202) throw new Error(`IndexNow returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  console.log(`IndexNow accepted ${payload.urlList.length} URL(s) for ${host} (HTTP ${response.status})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`indexnow-submit: ${error.message}`);
    process.exit(1);
  });
}
