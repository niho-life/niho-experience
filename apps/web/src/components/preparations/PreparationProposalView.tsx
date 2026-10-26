import type { ExperiencePreparationImage, ExperiencePreparationProposal } from "@niho-experience/api-client/experience-preparations";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const PARTY = { PROVIDER: "店舗", NIHO: "NIHO事務局", COLLABORATOR: "協力者" } as const;
const CANCELLATION = {
  FLEXIBLE: "体験開始の24時間前まで無料で取り消せます。24時間前を過ぎた場合は返金されません。",
  MODERATE: "体験開始の48時間前まで無料で取り消せます。48時間前を過ぎた場合は返金されません。",
  STRICT: "予約確定後の無料取消はありません。",
} as const;

type Page = ExperiencePreparationProposal["pages"]["ja"];

function TextItems({ items, empty = "なし" }: { items: string[]; empty?: string }) {
  return items.length ? <ul className="mt-1 list-disc space-y-1 pl-5">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p className="mt-1 text-ink-soft">{empty}</p>;
}

function SignedImage({ image, className }: { image: ExperiencePreparationImage; className: string }) {
  // Signed review URLs are short-lived and cannot be configured as a stable next/image remote source.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={image.thumbSignedUrl || image.signedUrl || ""} alt={image.alt} className={className} />;
}

function PageContent({ page, language, images }: { page: Page; language: "日本語" | "英語"; images: ExperiencePreparationImage[] }) {
  const content = page.content;
  const meetingImage = content.meetingPoint.exteriorPhotoObjectKey ? images.find((image) => image.objectKey === content.meetingPoint.exteriorPhotoObjectKey) : null;
  return (
    <div className="space-y-5">
      <div><h3 className="font-display text-xl font-medium">{page.title}</h3><p className="mt-2 whitespace-pre-wrap">{content.lead || "短い紹介はありません。"}</p><p className="mt-3 whitespace-pre-wrap text-ink-soft">{content.description || "詳しい紹介はありません。"}</p></div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div><dt className="text-xs font-bold text-ink-soft">対応言語</dt><dd>{content.facts.language || "未設定"}</dd></div>
        <div><dt className="text-xs font-bold text-ink-soft">見どころ</dt><dd><TextItems items={content.highlights} /></dd></div>
        <div><dt className="text-xs font-bold text-ink-soft">含まれるもの</dt><dd><TextItems items={content.included} /></dd></div>
        <div><dt className="text-xs font-bold text-ink-soft">含まれないもの</dt><dd><TextItems items={content.notIncluded} /></dd></div>
        <div><dt className="text-xs font-bold text-ink-soft">参加に向かない方</dt><dd><TextItems items={content.notSuitableFor} /></dd></div>
        <div><dt className="text-xs font-bold text-ink-soft">事前案内</dt><dd><TextItems items={content.knowBeforeYouGo} /></dd></div>
      </dl>
      <div><h4 className="text-xs font-bold text-ink-soft">当日の流れ</h4>{content.timeline.length ? <ol className="mt-2 space-y-3">{content.timeline.map((item, index) => <li key={`${item.time}-${item.title}-${index}`} className="rounded-xl bg-sand p-3"><p className="font-extrabold">{item.time}　{item.title}</p><p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{item.text}</p></li>)}</ol> : <p className="mt-1 text-ink-soft">なし</p>}</div>
      <div><h4 className="text-xs font-bold text-ink-soft">集合案内</h4><p className="mt-1 whitespace-pre-wrap">{content.meetingPoint.entranceNote || "未設定"}</p>{meetingImage?.thumbSignedUrl || meetingImage?.signedUrl ? <SignedImage image={meetingImage} className="mt-3 aspect-[4/3] w-full max-w-sm rounded-2xl object-cover" /> : content.meetingPoint.exteriorPhotoObjectKey ? <p className="mt-2 text-sm text-ink-soft">集合場所の外観写真を確認できません。</p> : null}</div>
      <p className="text-xs text-ink-soft">この欄は公開する{language}原稿です。</p>
    </div>
  );
}

function safePublicUrl(value: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : null; } catch { return null; }
}

export function PreparationProposalView({ proposal, images }: { proposal: ExperiencePreparationProposal; images: ExperiencePreparationImage[] }) {
  const offer = proposal.offer;
  const sellerUrl = safePublicUrl(proposal.provider.sellerDisclosureUrl);
  const childAges = offer.childMinAge === null && offer.childMaxAge === null ? "年齢設定なし" : `${offer.childMinAge ?? 0}〜${offer.childMaxAge ?? 17}歳`;
  return (
    <div className="space-y-8">
      <section aria-labelledby="preparation-provider-heading" className="space-y-3">
        <div><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">販売者</p><h2 id="preparation-provider-heading" className="font-display text-2xl font-medium">{proposal.provider.displayName}</h2></div>
        <p className="whitespace-pre-wrap text-ink-soft">{proposal.provider.bio || "店舗・提供者紹介はありません。"}</p>
        <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs font-bold text-ink-soft">販売者区分</dt><dd>{proposal.provider.kind === "BUSINESS" ? "事業者" : "個人"}</dd></div><div><dt className="text-xs font-bold text-ink-soft">販売者情報・特定商取引法に基づく表示</dt><dd>{sellerUrl ? <a className="break-all underline" href={sellerUrl} target="_blank" rel="noreferrer">{proposal.provider.sellerDisclosureUrl}</a> : proposal.provider.sellerDisclosureUrl || "未設定"}</dd></div></dl>
      </section>

      <section aria-labelledby="preparation-listing-heading" className="space-y-4 border-t border-line pt-7">
        <div><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">掲載内容</p><h2 id="preparation-listing-heading" className="font-display text-2xl font-medium">日本語の確認内容</h2></div>
        {images.length ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{images.map((image) => image.thumbSignedUrl || image.signedUrl ? <SignedImage key={image.objectKey} image={image} className="aspect-[4/3] w-full rounded-2xl object-cover" /> : <div key={image.objectKey} className="flex aspect-[4/3] items-center justify-center rounded-2xl bg-sand text-sm text-ink-soft">画像を確認できません</div>)}</div> : <p className="rounded-2xl bg-sand p-4 text-ink-soft">写真はまだありません。</p>}
        <PageContent page={proposal.pages.ja} language="日本語" images={images} />
      </section>

      <section aria-labelledby="preparation-public-english-heading" className="space-y-4 border-t border-line pt-7">
        <div><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">公開する英語</p><h2 id="preparation-public-english-heading" className="font-display text-2xl font-medium">英語の掲載内容</h2></div>
        <PageContent page={proposal.pages.en} language="英語" images={images} />
      </section>

      <section aria-labelledby="preparation-sales-heading" className="space-y-4 border-t border-line pt-7">
        <div><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">販売条件</p><h2 id="preparation-sales-heading" className="font-display text-2xl font-medium">{offer.nameJa}</h2><p className="mt-1 font-extrabold">{offer.nameEn}</p></div>
        <div className="grid gap-3 sm:grid-cols-2"><p className="whitespace-pre-wrap"><span className="block text-xs font-bold text-ink-soft">商品の短い説明（日本語）</span>{offer.shortDescriptionJa || "なし"}</p><p className="whitespace-pre-wrap"><span className="block text-xs font-bold text-ink-soft">商品の短い説明（英語）</span>{offer.shortDescriptionEn || "なし"}</p></div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div><dt className="text-xs font-bold text-ink-soft">大人料金</dt><dd className="font-extrabold">1人 ¥{offer.priceYen.toLocaleString("ja-JP")}</dd></div>
          <div><dt className="text-xs font-bold text-ink-soft">子ども料金</dt><dd>{offer.childPriceYen === null ? "設定なし" : `1人 ¥${offer.childPriceYen.toLocaleString("ja-JP")}`}</dd></div>
          <div><dt className="text-xs font-bold text-ink-soft">子どもの対象年齢</dt><dd>{childAges}</dd></div>
          <div><dt className="text-xs font-bold text-ink-soft">子どもの同伴条件</dt><dd>{offer.adultRequiredForChild ? "大人の同伴が必要" : "大人の同伴は必須ではありません"}</dd></div>
          <div><dt className="text-xs font-bold text-ink-soft">人数</dt><dd>{offer.minimumParticipants}〜{offer.capacity}人（1予約 最大{offer.maxPartySize}人）</dd></div>
          <div><dt className="text-xs font-bold text-ink-soft">開催</dt><dd>{offer.weekdays.map((day) => WEEKDAYS[day]).join("・") || "曜日未設定"} {offer.startTime}、{offer.durationMinutes}分</dd></div>
          <div><dt className="text-xs font-bold text-ink-soft">受付</dt><dd>{offer.cutoffDays}日前まで・{offer.acceptanceMode === "INSTANT" ? "予約時に確定" : "店舗の確認後に確定"}</dd></div>
          <div><dt className="text-xs font-bold text-ink-soft">休業日</dt><dd>{offer.closedDates.join("、") || "設定なし"}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs font-bold text-ink-soft">取消条件</dt><dd>{CANCELLATION[offer.cancellationPolicy]}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="preparation-roles-heading" className="space-y-4 border-t border-line pt-7">
        <div><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">運営分担</p><h2 id="preparation-roles-heading" className="font-display text-2xl font-medium">誰が何をするか</h2></div>
        <div className="grid gap-4 sm:grid-cols-2">{proposal.operatingRoles.map((role, index) => <div key={`${role.party}-${index}`}><h3 className="font-extrabold">{PARTY[role.party]}</h3><TextItems items={role.responsibilities} /></div>)}</div>
        <div className="rounded-xl bg-sand p-4"><h3 className="font-extrabold">サブホスト</h3>{proposal.cohosts.length ? <ul className="mt-2 list-disc pl-5">{proposal.cohosts.map((cohost) => <li key={cohost.userId}>{cohost.displayName}</li>)}</ul> : <p className="mt-1 text-ink-soft">サブホストはいません。</p>}<p className="mt-2 text-sm text-ink-soft">表示されたサブホストは、この提供者のすべての体験・開催条件・予約、予約者情報と返信を継続して担当します。販売者名義・法的同意・Stripe・売上受取・メンバー管理はオーナー専用です。</p></div>
      </section>
    </div>
  );
}
