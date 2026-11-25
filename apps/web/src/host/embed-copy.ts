/** 自分のサイトに貼る (#638): the page's words, shared by the server page (mock mode) and the client workspace (http mode). */

export const EMBED_PAGE_TITLE = "自分のサイトに貼る";
export const EMBED_NOT_PUBLISHED = "この体験を公開すると使えます。保存していない変更があるときは、公開内容を更新してからお使いください。";
export const EMBED_JAPANESE_ONLY = "日本語だけで公開している体験は、まだ埋め込みに対応していません。体験の一覧の「予約リンクをコピー」は使えます。";

export function embedIntro(title: string): string {
  return `STUDIO・WordPress・Wix などで作ったサイトに、「${title}」の予約を表示できます。予約・決済・返金は、今までどおりこの画面で管理します。`;
}
