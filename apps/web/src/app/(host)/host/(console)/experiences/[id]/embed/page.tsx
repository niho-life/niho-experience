import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostEmbedCode } from "@/components/host/HostEmbedCode";
import { HostEmbedNotice, HostEmbedPage, HostEmbedWorkspace } from "@/components/host/HostEmbedWorkspace";
import { EMBED_NOT_PUBLISHED, embedIntro } from "@/host/embed-copy";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { hostPageContext, loadHostExperienceEditor } from "@/host/data";
import { experiencePath } from "@/host/home";
import { config } from "@/lib/config";
import { withProvider } from "@/lib/host/routes";

export const metadata: Metadata = { title: "自分のサイトに貼る" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * 自分のサイトに貼る (#638, docs/embed.md「ホストの画面」): the booking widget's code for one published experience. Whoever can
 * open the experience's editor can open this. Off (EXPERIENCE_EMBED_ENABLED) it does not exist.
 */
export default async function HostExperienceEmbedPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  if (!config.embedEnabled) notFound();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const siteOrigin = new URL(config.siteUrl).origin;
  if (config.experienceHostPublicationApiEnabled) {
    // As the editor (experiences/[id]/page.tsx): the client reads the product through the host API with the session.
    return <HostEmbedWorkspace productId={id} siteOrigin={siteOrigin} backHref={`/host/experiences/${encodeURIComponent(id)}`} />;
  }
  const context = await hostPageContext(query);
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="体験" />;
  const backHref = withProvider(experiencePath(id), linkProviderId);
  const { editor } = await loadHostExperienceEditor(provider, id);
  if (editor.status === "missing") notFound();
  if (editor.status === "unavailable") {
    return (
      <HostEmbedPage backHref={backHref}>
        <HostEmbedNotice>
          <b className="block font-extrabold text-ink">この画面は準備中です</b>
          体験ページの原稿・写真・商品の編集と掲載の申請は、NIHO との接続ができしだいここから行えるようになります。
        </HostEmbedNotice>
      </HostEmbedPage>
    );
  }
  const { experience } = editor;
  return (
    <HostEmbedPage backHref={backHref}>
      {experience.status !== "live"
        ? <HostEmbedNotice>{EMBED_NOT_PUBLISHED}</HostEmbedNotice>
        : <>
          <p className="text-ink-soft">{embedIntro(experience.title)}</p>
          <HostEmbedCode siteOrigin={siteOrigin} slug={experience.slug} title={experience.title} />
        </>}
    </HostEmbedPage>
  );
}
