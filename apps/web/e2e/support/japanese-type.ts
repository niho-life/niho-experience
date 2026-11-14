import type { Page } from "@playwright/test";

/**
 * Japanese text on a Japanese screen (<html lang="ja">) that is not set in NIHO Sans (#615): one line per element,
 * "tag 「text」 font-family". Hand-written accents (Caveat) pass when their Japanese falls to "NIHO Hand JA". Parts that
 * show the English site (lang="en": the host's preview, an English article being written), the stamp's SVG and form
 * fields are left out. It reads the computed font-family, so it holds on any runner, with or without the Mac fonts.
 */
export async function japaneseTextOutsideNihoSans(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const japanese = /[぀-ヿ㐀-鿿]/;
    const found = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      const element = node.parentElement;
      if (!element || !japanese.test(text)) continue;
      if (element.closest("script, style, noscript, svg, textarea, [lang='en']")) continue;
      const family = getComputedStyle(element).fontFamily;
      if (/"NIHO Sans"/.test(family) || /^"Caveat Variable", "NIHO Hand JA"/.test(family)) continue;
      found.add(`${element.tagName.toLowerCase()} 「${text.slice(0, 16)}」 ${family}`);
    }
    return [...found];
  });
}
