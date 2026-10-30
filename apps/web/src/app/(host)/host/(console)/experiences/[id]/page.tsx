import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HostExperienceEditor } from "@/components/host/HostExperienceEditor";
import { HostLiveExperienceEditor } from "@/components/host/HostLiveExperienceEditor";
import { HostIcon } from "@/components/host/HostIcon";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody } from "@/components/host/ui";
import { hostPageContext, loadHostExperienceEditor } from "@/host/data";
import { config } from "@/lib/config";
import { HOST_EXPERIENCES_PATH, HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";

export const metadata: Metadata = { title: "体験の編集" };

type SearchParams = Record<string, string | string[] | undefined>;

/** http mode until the provider API can read and save pages (#87): the way back and nothing that pretends to work. */
function EditorUnavailable({ backHref }: { backHref: string }) {
  return (
    <>
      <HostSubHeader backHref={backHref} backLabel="体験" title="体験の編集" />
      <HostPageBody>
        <div className="mb-3.5 flex items-center gap-3 md:mb-[18px]">
          <Link href={backHref} aria-label="体験へ戻る" className="grid size-10 shrink-0 place-items-center rounded-full bg-sand hover:bg-line max-md:hidden">
            <HostIcon name="chevronLeft" className="size-[18px]" />
          </Link>
          <h1 className="font-sans text-[1.0625rem] leading-[1.3] font-extrabold tracking-normal md:text-[1.375rem]">体験の編集</h1>
        </div>
        <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">この画面は準備中です</p>
          <p className="mt-1 text-ink-soft">体験ページの原稿・写真・商品の編集と掲載の申請は、NIHO との接続ができしだいここから行えるようになります。</p>
        </section>
      </HostPageBody>
    </>
  );
}

/** 体験の編集 (#89): the page, its photos and offers, and its one listing state. */
export default async function HostExperiencePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const context = await hostPageContext(query);
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="体験" />;
  const backHref = withProvider(HOST_EXPERIENCES_PATH, linkProviderId);
  const settingsHref = withProvider(HOST_SETTINGS_PATH, linkProviderId);
  if (providerOperationsEnabled()) {
    return <HostLiveExperienceEditor key={`${provider.id}/${id}`} providerId={provider.id} pageId={id} backHref={backHref} role={provider.memberRole} reviewStatus={provider.reviewStatus} settingsHref={settingsHref} siteUrl={config.siteUrl} />;
  }
  const { editor, host, today } = await loadHostExperienceEditor(provider, id);
  if (editor.status === "missing") notFound();
  if (editor.status === "unavailable") return <EditorUnavailable backHref={backHref} />;

  return (
    // Keyed by provider and experience: opening another one starts from its own page.
    <HostExperienceEditor
      key={`${provider.id}/${editor.experience.id}`}
      experience={editor.experience}
      providerId={provider.id}
      host={host}
      today={today}
      siteUrl={config.siteUrl}
      backHref={backHref}
      settingsHref={settingsHref}
    />
  );
}
