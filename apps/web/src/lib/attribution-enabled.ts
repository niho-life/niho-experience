import { config } from "./config";

/**
 * 流入の印（utm_*）を取り込んで予約に結び付けるか（#531・#59）。NIHO のカタログの予約は従来どおり公開 API 1.2 のとき。
 * このサイトが公開する体験（http mode かつ公開機能が ON）は、API の版によらず取り込む：予約フォームが印を checkout へ送り、
 * サーバーが Do Not Track を見て保存する。日本語のページ（/ja）にも英語と同じ取り込みを置く。
 */
export function attributionEnabled(): boolean {
  return config.publicApiVersion === "1.2" || (config.apiMode === "http" && config.experiencePublicationsEnabled);
}
