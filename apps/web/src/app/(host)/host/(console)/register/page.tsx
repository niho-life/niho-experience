import type { Metadata } from "next";
import { HostNoHostGuide } from "@/components/host/HostRegisterPrompt";
import { HostRegisterForm } from "@/components/host/HostRegisterForm";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { loadRegistrationConsent } from "@/host/data";
import { HOST_REGISTER_PATH } from "@/lib/host/routes";
import { isHostMock } from "@/lib/host/server";

export const metadata: Metadata = { title: "提供者の登録" };

/**
 * Provider registration (#88): the form sends the registration with the version of NIHO's
 * provider terms shown here (NIHO in http mode, the contract mock in mock mode).
 */
export default async function HostRegisterPage() {
  // Against the real API the old registration cannot work (#695): guide to the inquiry instead of showing NIHO's error.
  if (!isHostMock()) return <HostNoHostGuide title="ホストの登録" />;
  const consent = await loadRegistrationConsent();
  return (
    <HostPageBody>
      <PageHead title="提供者の登録" />
      {consent ? (
        <>
          <p className="mb-3.5 text-ink-soft">体験サイトに表示する提供者の情報です。登録のあと、体験ページを作れます。</p>
          <HostRegisterForm consent={{ version: consent.version, text: consent.text }} preview={isHostMock()} />
        </>
      ) : (
        <section role="alert" className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">提供者規約を読み込めませんでした</p>
          <p className="mt-1 text-ink-soft">NIHO に接続できませんでした。時間をおいて、もう一度お試しください。</p>
          <p className="mt-4">
            <a href={HOST_REGISTER_PATH} className="font-bold text-moss underline underline-offset-4">
              もう一度読み込む
            </a>
          </p>
        </section>
      )}
    </HostPageBody>
  );
}
