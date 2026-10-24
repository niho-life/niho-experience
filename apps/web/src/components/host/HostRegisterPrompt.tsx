import Link from "next/link";
import { HOST_REGISTER_PATH, HOST_SUPPORT_PATH } from "@/lib/host/routes";
import { consoleButtonClass, HOST_HEADING, HOST_SURFACE } from "./host-ui";
import { HostPageBody, PageHead } from "./ui";

/** An account without a registered provider still keeps the independent normal-location support route. */
export function HostRegisterPrompt({ title }: { title: string }) {
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
