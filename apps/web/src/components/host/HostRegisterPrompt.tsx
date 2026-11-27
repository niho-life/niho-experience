import Link from "next/link";
import { config } from "@/lib/config";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import { HOST_REGISTER_PATH, HOST_SUPPORT_PATH } from "@/lib/host/routes";
import { isHostMock } from "@/lib/host/server";
import { isHostSupportSettingsEnabled } from "@/lib/host/support-settings-server";
import { consoleButtonClass, HOST_HEADING, HOST_SURFACE } from "./host-ui";
import { HostPageBody, PageHead } from "./ui";

/** NIHO's public support address, used when the inquiry form is closed (same address as the sign-in error page). */
const LISTING_MAIL_HREF = "mailto:info@niho.life?subject=NIHO%20Travel%20%E4%BD%93%E9%A8%93%E3%81%AE%E6%8E%B2%E8%BC%89%E3%81%AE%E7%9B%B8%E8%AB%87";

/**
 * An account that belongs to no host, against the real API (#695): the old registration screen needs NIHO's former API and
 * can only fail, so the person is pointed to the inquiry form (or the writer screen) until hosts can register themselves.
 */
export function HostNoHostGuide({ title }: { title: string }) {
  const listingHref = groupInquiryOpen() ? inquiryHref("ja", { type: "LISTING", from: "LISTING" }) : LISTING_MAIL_HREF;
  const supportUsable = isHostSupportSettingsEnabled();
  return (
    <HostPageBody>
      <PageHead title={title} />
      <section aria-labelledby="no-host-heading" className={`${HOST_SURFACE} p-5 md:p-6`}>
        <h2 id="no-host-heading" className={`${HOST_HEADING} text-lg leading-snug`}>
          まだどのホストにも属していません
        </h2>
        <p className="mt-2 text-ink-soft">体験を載せたいときは、まず相談してください。</p>
        <p className="mt-5 flex flex-wrap gap-2">
          <a href={listingHref} className={consoleButtonClass("primary", "lg")}>体験の掲載を相談する</a>
          {config.nihoWriterEnabled ? <Link href="/write" className={consoleButtonClass("secondary", "lg")}>記事を書く</Link> : null}
          {supportUsable ? <Link href={HOST_SUPPORT_PATH} className={consoleButtonClass("secondary", "lg")}>NIHOサポート設定</Link> : null}
        </p>
      </section>
    </HostPageBody>
  );
}

/** An account without a registered provider: guidance against the real API, the registration form in the preview. */
export function HostRegisterPrompt({ title }: { title: string }) {
  if (!isHostMock()) return <HostNoHostGuide title={title} />;
  return (
    <HostPageBody>
      <PageHead title={title} />
      <section aria-labelledby="register-heading" className={`${HOST_SURFACE} p-5 md:p-6`}>
        <h2 id="register-heading" className={`${HOST_HEADING} text-lg leading-snug`}>
          体験を掲載する場合は提供者登録へ
        </h2>
        <p className="mt-2 text-ink-soft">体験を掲載するには、個人または事業者として提供者の登録が必要です。通常拠点のNIHOサポート設定だけを確認する場合、提供者登録は必要ありません。</p>
        <p className="mt-5 flex flex-wrap gap-2">
          <Link href={HOST_REGISTER_PATH} className={consoleButtonClass("primary", "lg")}>
            提供者として登録
          </Link>
          <Link href={HOST_SUPPORT_PATH} className={consoleButtonClass("secondary", "lg")}>NIHOサポート設定</Link>
        </p>
      </section>
    </HostPageBody>
  );
}
