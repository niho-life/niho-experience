import type { Metadata } from "next";
import { HostBioForm } from "@/components/host/HostBioForm";
import { HostSettingsBackLink } from "@/components/host/HostSettingsBackLink";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext } from "@/host/data";
import { config } from "@/lib/config";
import { providerHostBioRepository } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "ホスト紹介" };

export default async function HostProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await hostPageContext(await searchParams);
  if (!context) return null;
  const { provider, providerNotFound } = context;
  const editable = provider?.memberRole === "OWNER" && !providerNotFound && config.experienceHostPublicationApiEnabled && config.apiMode === "http";
  const overview = editable
    ? await providerHostBioRepository()?.getConsoleOverview({ providerId: provider.id, nihoUserId: provider.nihoUserId }).catch(() => null)
    : null;
  const description = overview?.kind === "PERSON"
    ? "旅行者に向けて、ホストとしてのあなた自身を紹介する文章です。"
    : overview?.kind === "BUSINESS"
      ? `旅行者に向けて、「${provider?.displayName ?? "この提供者"}」を紹介する文章です。メンバー一人ひとりの紹介は、それぞれが「あなたのアカウント」で書きます。`
      : "旅行者に向けて、体験を提供するホストを紹介する文章です。";
  return <HostPageBody>
    <HostSettingsBackLink providerId={provider?.id} />
    <PageHead title="ホスト紹介" />
    {editable ? <>
      <p className="mb-4 text-ink-soft">{description}日本語で書き、英語は内容を確認してから公開します。紹介文は200字くらいが目安です。</p>
      <HostBioForm key={provider.id} providerId={provider.id} />
    </> : <p className="text-ink-soft">{providerNotFound ? "指定した提供者を開けませんでした。" : "ホスト紹介の編集には提供者のオーナー権限が必要です。"}</p>}
  </HostPageBody>;
}
