"use client";

import { useId, type ReactNode } from "react";
import type { ExperienceProviderPageDetail } from "@niho-experience/api-client/host";
import { EDITOR_LIMITS } from "@/host/editor";
import { AddRowButton, EditorPanel, FIELD_LABEL, LIST_INPUT, LIST_INPUT_SUB, LIST_INPUT_TIME, RemoveButton, SUB_HEADING, TextList, useFocusAfterRender } from "./editor-parts";
import { INPUT, SELECT, TEXTAREA } from "./fields";
import type { LiveContent, LiveTimelineStep } from "./live-editor-state";

/*
 * 体験の編集 › 本文 (#89, NIHO 接続版): the panels of the mock editor (HostEditorContent) for the page content NIHO keeps, in
 * the public order. The words are in the page's language (`lang`). A row left blank is dropped when saving, as NIHO does,
 * and the limits are the ones the host contract states (EDITOR_LIMITS has the same numbers). 参加の条件 (#285) and
 * 迎える人 (`hostUserIds`, empty on a provider's page) are not here.
 */

type Photos = ExperienceProviderPageDetail["photos"];
type Lang = "ja" | "en";

const photoLabel = (index: number) => `写真 ${index + 1}${index === 0 ? "（表紙）" : ""}`;

/** 当日の流れ: a time, a title, a line and (when the page has photos) one of them per step. */
function LiveTimelinePanel({ steps, photos, lang, onChange }: { steps: readonly LiveTimelineStep[]; photos: Photos; lang: Lang; onChange: (steps: LiveTimelineStep[]) => void }) {
  const baseId = useId();
  const focusLater = useFocusAfterRender();
  const { items, title: titleLength, text: textLength } = EDITOR_LIMITS.timeline;
  const full = steps.length >= items;
  const add = () => {
    focusLater(`${baseId}-${steps.length}-title`);
    onChange([...steps, { time: "", title: "", text: "", photoObjectKey: null }]);
  };
  const remove = (index: number) => {
    const left = steps.length - 1;
    focusLater(left > 0 ? `${baseId}-${Math.min(index, left - 1)}-time` : `${baseId}-add`);
    onChange(steps.filter((_, other) => other !== index));
  };
  const change = (index: number, patch: Partial<LiveTimelineStep>) => onChange(steps.map((step, other) => (other === index ? { ...step, ...patch } : step)));
  return (
    <EditorPanel
      id="editor-timeline"
      title="当日の流れ"
      actions={steps.length && !full ? <AddRowButton id={`${baseId}-add`} label="段を足す" onClick={add} /> : null}
    >
      {steps.length ? (
        <ol>
          {steps.map((step, index) => {
            const chosen = photos.some((photo) => photo.objectKey === step.photoObjectKey) ? step.photoObjectKey : null;
            return (
              <li key={index} className="flex items-start gap-2 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
                <input
                  id={`${baseId}-${index}-time`}
                  aria-label={`当日の流れ ${index + 1} の時刻`}
                  value={step.time}
                  inputMode="numeric"
                  placeholder="18:00"
                  maxLength={5}
                  pattern="([01]?[0-9]|2[0-3]):[0-5][0-9]"
                  title="18:00 のように 24 時間で入力します"
                  onChange={(event) => change(index, { time: event.currentTarget.value })}
                  className={LIST_INPUT_TIME}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <input id={`${baseId}-${index}-title`} aria-label={`当日の流れ ${index + 1} の題`} lang={lang} value={step.title} maxLength={titleLength} placeholder="題" onChange={(event) => change(index, { title: event.currentTarget.value })} className={LIST_INPUT} />
                  <input aria-label={`当日の流れ ${index + 1} の一言`} lang={lang} value={step.text} maxLength={textLength} placeholder="一言" onChange={(event) => change(index, { text: event.currentTarget.value })} className={LIST_INPUT_SUB} />
                  {photos.length ? (
                    <select aria-label={`当日の流れ ${index + 1} の写真`} value={chosen ?? ""} onChange={(event) => change(index, { photoObjectKey: event.currentTarget.value || null })} className={SELECT}>
                      <option value="">写真なし</option>
                      {photos.map((photo, at) => <option key={photo.objectKey} value={photo.objectKey}>{photoLabel(at)}</option>)}
                    </select>
                  ) : null}
                </div>
                <RemoveButton label={`当日の流れ ${index + 1} を削除`} onClick={() => remove(index)} />
              </li>
            );
          })}
        </ol>
      ) : (
        <AddRowButton id={`${baseId}-add`} label="段を足す" onClick={add} />
      )}
      {full ? <p className="mt-2 text-xs text-muted">段は{items}つまでです</p> : null}
      {steps.length && photos.length === 0 ? <p className="mt-2 text-xs text-muted">写真を追加すると、段ごとに写真を選べます。</p> : null}
    </EditorPanel>
  );
}

/** 外観写真 (inside 集合場所): one of the page's photos, shown to booked guests. Without photos there is nothing to choose. */
export function LiveExteriorPhoto({ photos, value, onChange }: { photos: Photos; value: string | null; onChange: (objectKey: string | null) => void }) {
  const id = useId();
  const chosen = photos.find((photo) => photo.objectKey === value) ?? null;
  return (
    <div className="mt-3.5 flex flex-col gap-1.5 border-t border-line pt-3.5">
      {photos.length ? (
        <>
          <label htmlFor={id} className={FIELD_LABEL}>外観写真</label>
          <div className="flex flex-wrap items-center gap-3">
            {chosen?.url ? (
              // eslint-disable-next-line @next/next/no-img-element -- a signed storage URL or a sample path
              <img src={chosen.url} alt="" className="h-20 w-[120px] rounded-[10px] bg-sand object-cover" />
            ) : null}
            <select id={id} value={chosen?.objectKey ?? ""} onChange={(event) => onChange(event.currentTarget.value || null)} className={SELECT}>
              <option value="">選ばない</option>
              {photos.map((photo, at) => <option key={photo.objectKey} value={photo.objectKey}>{photoLabel(at)}</option>)}
            </select>
          </div>
        </>
      ) : (
        <>
          <span className={FIELD_LABEL}>外観写真</span>
          <p className="text-[0.8125rem] text-muted">写真を追加すると、その中から外観写真を選べます。</p>
        </>
      )}
    </div>
  );
}

export interface LiveContentPanelsProps {
  content: LiveContent;
  photos: Photos;
  /** The page's language: the words are Japanese or English. */
  lang: Lang;
  onContent: (patch: Partial<LiveContent>) => void;
  /** 集合場所 sits between 当日の流れ and 注意事項, as on the public page. */
  meeting: ReactNode;
}

/** The mock editor's panels from ひとこと紹介 to 注意事項, over NIHO's page content. */
export function LiveContentPanels({ content, photos, lang, onContent, meeting }: LiveContentPanelsProps) {
  const { list, highlights, knowBeforeYouGo } = EDITOR_LIMITS;
  return (
    <>
      <EditorPanel id="editor-lead" title="ひとこと紹介">
        <textarea aria-labelledby="editor-lead" lang={lang} rows={3} value={content.lead} maxLength={EDITOR_LIMITS.lead} onChange={(event) => onContent({ lead: event.currentTarget.value })} className={TEXTAREA} />
      </EditorPanel>

      <EditorPanel id="editor-day-language" title="当日の言語">
        <input
          aria-labelledby="editor-day-language"
          lang={lang}
          value={content.facts.language}
          maxLength={EDITOR_LIMITS.dayLanguage}
          placeholder={lang === "en" ? "例: English and Japanese" : "例: 英語と日本語"}
          onChange={(event) => onContent({ facts: { language: event.currentTarget.value } })}
          className={`${INPUT} md:max-w-[240px]`}
        />
      </EditorPanel>

      <EditorPanel id="editor-highlights" title="見どころ">
        <TextList label="見どころ" lang={lang} values={content.highlights} max={highlights.items} maxLength={highlights.length} onChange={(values) => onContent({ highlights: values })} />
      </EditorPanel>

      <EditorPanel id="editor-description" title="詳しい説明">
        <textarea aria-labelledby="editor-description" lang={lang} rows={5} value={content.description} maxLength={EDITOR_LIMITS.description} onChange={(event) => onContent({ description: event.currentTarget.value })} className={TEXTAREA} />
      </EditorPanel>

      <EditorPanel id="editor-included" title="含まれるもの・含まれないもの">
        {/* Two columns once the panel is wide enough (PC), one on phones. */}
        <div className="@container">
          <div className="grid gap-4 @lg:grid-cols-2 @lg:gap-5">
            <div className="min-w-0">
              <h3 className={SUB_HEADING}>含まれるもの</h3>
              <TextList label="含まれるもの" lang={lang} values={content.included} max={list.items} maxLength={list.length} onChange={(values) => onContent({ included: values })} />
            </div>
            <div className="min-w-0">
              <h3 className={SUB_HEADING}>含まれないもの</h3>
              <TextList label="含まれないもの" lang={lang} values={content.notIncluded} max={list.items} maxLength={list.length} onChange={(values) => onContent({ notIncluded: values })} />
            </div>
          </div>
        </div>
      </EditorPanel>

      <EditorPanel id="editor-not-suitable" title="向かない人">
        <TextList label="向かない人" lang={lang} values={content.notSuitableFor} max={list.items} maxLength={list.length} onChange={(values) => onContent({ notSuitableFor: values })} />
      </EditorPanel>

      <LiveTimelinePanel steps={content.timeline} photos={photos} lang={lang} onChange={(timeline) => onContent({ timeline })} />

      {meeting}

      <EditorPanel id="editor-know" title="注意事項">
        <TextList label="注意事項" lang={lang} values={content.knowBeforeYouGo} max={knowBeforeYouGo.items} maxLength={knowBeforeYouGo.length} onChange={(values) => onContent({ knowBeforeYouGo: values })} />
      </EditorPanel>
    </>
  );
}
