"use client";

import type { ExperienceProviderPageOffer } from "@niho-experience/api-client/host";
import { editLines, emptyLiveOffer, LIVE_OFFER_LIMIT, LIVE_QUESTION_LIMIT, LIVE_QUESTION_OPTION_LIMIT, moveLiveOffer, removeLiveOffer } from "./live-editor-state";
import { consoleButtonClass } from "./host-ui";
import { DISABLED } from "./editor-parts";
import { FieldRow, FieldSection, INPUT, TEXTAREA } from "./fields";

type BookingQuestion = ExperienceProviderPageOffer["bookingQuestions"][number];
type BookingQuestionOption = BookingQuestion["options"][number];
type BookingQuestionType = BookingQuestion["inputType"];

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const QUESTION_TYPES: { value: BookingQuestionType; label: string }[] = [
  { value: "SHORT_TEXT", label: "短文で回答" },
  { value: "LONG_TEXT", label: "長文で回答" },
  { value: "SINGLE_SELECT", label: "1つ選択" },
  { value: "MULTI_SELECT", label: "複数選択" },
];
const isSelection = (type: BookingQuestionType) => type === "SINGLE_SELECT" || type === "MULTI_SELECT";
const draftId = () => `draft:${crypto.randomUUID()}`;

export function HostLiveOfferEditor({ offers, disabled, onChange }: {
  offers: ExperienceProviderPageOffer[];
  disabled: boolean;
  onChange: (offers: ExperienceProviderPageOffer[]) => void;
}) {
  const updateOffer = (index: number, patch: Partial<ExperienceProviderPageOffer>) => onChange(offers.map((offer, at) => at === index ? { ...offer, ...patch } : offer));
  const updateQuestion = (offerIndex: number, questionIndex: number, patch: Partial<BookingQuestion>) => {
    const offer = offers[offerIndex];
    if (!offer) return;
    updateOffer(offerIndex, { bookingQuestions: offer.bookingQuestions.map((question, at) => at === questionIndex ? { ...question, ...patch } : question) });
  };
  const updateQuestionOption = (offerIndex: number, questionIndex: number, optionIndex: number, patch: Partial<BookingQuestionOption>) => {
    const offer = offers[offerIndex]; const question = offer?.bookingQuestions[questionIndex];
    if (!offer || !question) return;
    updateQuestion(offerIndex, questionIndex, { options: question.options.map((option, at) => at === optionIndex ? { ...option, ...patch } : option) });
  };
  const addOffer = () => {
    if (offers.length >= LIVE_OFFER_LIMIT) return;
    onChange([...offers, emptyLiveOffer(draftId(), offers.length)]);
  };

  return <>
    {offers.map((offer, index) => <FieldSection key={offer.id} title={`商品 ${index + 1}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={disabled || index === 0} aria-label={`商品 ${index + 1} を上へ`} onClick={() => onChange(moveLiveOffer(offers, index, -1))} className={consoleButtonClass("secondary", "sm", DISABLED)}>上へ</button>
        <button type="button" disabled={disabled || index === offers.length - 1} aria-label={`商品 ${index + 1} を下へ`} onClick={() => onChange(moveLiveOffer(offers, index, 1))} className={consoleButtonClass("secondary", "sm", DISABLED)}>下へ</button>
        <button type="button" disabled={disabled} aria-label={`商品 ${index + 1} を外す`} onClick={() => onChange(removeLiveOffer(offers, index))} className={consoleButtonClass("secondary", "sm", DISABLED)}>{`商品 ${index + 1} を外す`}</button>
        <span className="text-xs text-muted">予約履歴がある商品は削除できません。その場合は受付を停止してください。</span>
      </div>
      <FieldRow label="商品名" htmlFor={`offer-${index}-name`}><input id={`offer-${index}-name`} required maxLength={80} className={INPUT} value={offer.name} onChange={(event) => updateOffer(index, { name: event.target.value })} /></FieldRow>
      <FieldRow label="短い説明" htmlFor={`offer-${index}-description`}><input id={`offer-${index}-description`} maxLength={160} className={INPUT} value={offer.shortDescription ?? ""} onChange={(event) => updateOffer(index, { shortDescription: event.target.value || null })} /></FieldRow>
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        {([['priceYen','大人料金',0,1000000],['capacity','定員',1,500],['maxPartySize','1予約の上限',1,500],['minimumParticipants','最低催行人数',1,500],['durationMinutes','所要時間（分）',15,720],['cutoffDays','受付締切（日）',0,60]] as const).map(([key,label,min,max]) => <label key={key} className="font-extrabold">{label}<input type="number" min={min} max={max} className={`${INPUT} mt-1`} value={offer[key]} onChange={(event) => updateOffer(index, { [key]: Number(event.target.value) })} /></label>)}
        <label className="font-extrabold">子ども料金<input type="number" min={0} max={1000000} placeholder="設定なし" className={`${INPUT} mt-1`} value={offer.childPriceYen ?? ""} onChange={(event) => updateOffer(index, { childPriceYen: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <label className="font-extrabold">子ども最少年齢<input type="number" min={0} max={17} placeholder="設定なし" className={`${INPUT} mt-1`} value={offer.childMinAge ?? ""} onChange={(event) => updateOffer(index, { childMinAge: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <label className="font-extrabold">子ども最大年齢<input type="number" min={0} max={17} placeholder="設定なし" className={`${INPUT} mt-1`} value={offer.childMaxAge ?? ""} onChange={(event) => updateOffer(index, { childMaxAge: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <label className="font-extrabold">開始時刻<input type="time" className={`${INPUT} mt-1`} value={offer.startTime} onChange={(event) => updateOffer(index, { startTime: event.target.value })} /></label>
        <label className="font-extrabold">取消条件<select className={`${INPUT} mt-1`} value={offer.cancellationPolicy} onChange={(event) => updateOffer(index, { cancellationPolicy: event.target.value as ExperienceProviderPageOffer["cancellationPolicy"] })}><option value="FREE_UNTIL_24H">24時間前まで無料</option><option value="FREE_UNTIL_48H">48時間前まで無料</option><option value="NONE">無料取消なし</option></select></label>
        <label className="font-extrabold">受付方法<select className={`${INPUT} mt-1`} value={offer.acceptanceMode} onChange={(event) => updateOffer(index, { acceptanceMode: event.target.value as ExperienceProviderPageOffer["acceptanceMode"] })}><option value="APPROVAL">承認制</option><option value="INSTANT">即時確定</option></select></label>
      </div>
      <div className="flex flex-wrap gap-5 px-4 pb-4"><label className="inline-flex items-center gap-2 font-extrabold"><input type="checkbox" checked={offer.isActive} onChange={(event) => updateOffer(index, { isActive: event.target.checked })} />この商品を受付する</label><label className="inline-flex items-center gap-2 font-extrabold"><input type="checkbox" checked={offer.adultRequiredForChild} onChange={(event) => updateOffer(index, { adultRequiredForChild: event.target.checked })} />子どもは大人同伴</label></div>
      <fieldset className="p-4 pt-0"><legend className="font-extrabold">開催曜日</legend><div className="mt-2 flex flex-wrap gap-3">{WEEKDAYS.map((label, day) => <label key={label} className="inline-flex items-center gap-2"><input type="checkbox" checked={offer.weekdays.includes(day)} onChange={(event) => updateOffer(index, { weekdays: event.target.checked ? [...offer.weekdays, day].sort() : offer.weekdays.filter((value) => value !== day) })} />{label}</label>)}</div></fieldset>
      <FieldRow label="休みの日" htmlFor={`offer-${index}-closed`}><textarea id={`offer-${index}-closed`} rows={3} placeholder="YYYY-MM-DD（1行1件）" className={TEXTAREA} value={offer.closedDates.join("\n")} onChange={(event) => updateOffer(index, { closedDates: editLines(event.target.value) })} /></FieldRow>

      <div className="mt-3 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-extrabold">予約時の質問</h3><p className="mt-1 text-xs text-muted">予約者に入力してもらう質問を最大 {LIVE_QUESTION_LIMIT} 件設定できます。</p></div><button type="button" disabled={disabled || offer.bookingQuestions.length >= LIVE_QUESTION_LIMIT} onClick={() => updateOffer(index, { bookingQuestions: [...offer.bookingQuestions, { id: draftId(), prompt: "", description: null, inputType: "SHORT_TEXT", required: false, options: [] }] })} className={consoleButtonClass("secondary", "sm", DISABLED)}>質問を追加</button></div>
        {offer.bookingQuestions.map((question, questionIndex) => <fieldset key={question.id} className="mt-3 rounded-xl border border-line p-3">
          <legend className="px-1 font-extrabold">質問 {questionIndex + 1}</legend>
          <FieldRow label="質問文" htmlFor={`offer-${index}-question-${questionIndex}-prompt`}><input id={`offer-${index}-question-${questionIndex}-prompt`} required maxLength={120} className={INPUT} value={question.prompt} onChange={(event) => updateQuestion(index, questionIndex, { prompt: event.target.value })} /></FieldRow>
          <FieldRow label="補足" htmlFor={`offer-${index}-question-${questionIndex}-description`}><input id={`offer-${index}-question-${questionIndex}-description`} maxLength={300} className={INPUT} value={question.description ?? ""} onChange={(event) => updateQuestion(index, questionIndex, { description: event.target.value || null })} /></FieldRow>
          <FieldRow label="回答方法" htmlFor={`offer-${index}-question-${questionIndex}-type`}><select id={`offer-${index}-question-${questionIndex}-type`} className={INPUT} value={question.inputType} onChange={(event) => {
            const inputType = event.target.value as BookingQuestionType;
            const options = isSelection(inputType) ? (isSelection(question.inputType) ? question.options : [
              { id: draftId(), label: "" }, { id: draftId(), label: "" },
            ]) : [];
            updateQuestion(index, questionIndex, { inputType, options });
          }}>{QUESTION_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FieldRow>
          <label className="my-2 inline-flex items-center gap-2 font-extrabold"><input type="checkbox" checked={question.required} onChange={(event) => updateQuestion(index, questionIndex, { required: event.target.checked })} />回答を必須にする</label>
          {isSelection(question.inputType) ? <fieldset className="mt-2 rounded-lg bg-sand p-3"><legend className="font-extrabold">選択肢（2〜{LIVE_QUESTION_OPTION_LIMIT} 件）</legend>
            {question.options.map((option, optionIndex) => <div key={option.id} className="mt-2 flex items-center gap-2"><label className="sr-only" htmlFor={`offer-${index}-question-${questionIndex}-option-${optionIndex}`}>選択肢 {optionIndex + 1}</label><input id={`offer-${index}-question-${questionIndex}-option-${optionIndex}`} required maxLength={80} className={INPUT} value={option.label} onChange={(event) => updateQuestionOption(index, questionIndex, optionIndex, { label: event.target.value })} /><button type="button" disabled={disabled || optionIndex === 0} aria-label={`選択肢 ${optionIndex + 1} を上へ`} onClick={() => {
              const options = [...question.options]; [options[optionIndex - 1], options[optionIndex]] = [options[optionIndex]!, options[optionIndex - 1]!]; updateQuestion(index, questionIndex, { options });
            }} className={consoleButtonClass("secondary", "sm", DISABLED)}>上へ</button><button type="button" disabled={disabled || optionIndex === question.options.length - 1} aria-label={`選択肢 ${optionIndex + 1} を下へ`} onClick={() => {
              const options = [...question.options]; [options[optionIndex + 1], options[optionIndex]] = [options[optionIndex]!, options[optionIndex + 1]!]; updateQuestion(index, questionIndex, { options });
            }} className={consoleButtonClass("secondary", "sm", DISABLED)}>下へ</button><button type="button" disabled={disabled} aria-label={`選択肢 ${optionIndex + 1} を外す`} onClick={() => updateQuestion(index, questionIndex, { options: question.options.filter((_, at) => at !== optionIndex) })} className={consoleButtonClass("secondary", "sm", DISABLED)}>外す</button></div>)}
            <button type="button" disabled={disabled || question.options.length >= LIVE_QUESTION_OPTION_LIMIT} onClick={() => updateQuestion(index, questionIndex, { options: [...question.options, { id: draftId(), label: "" }] })} className={`${consoleButtonClass("secondary", "sm", DISABLED)} mt-2`}>選択肢を追加</button>
          </fieldset> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" disabled={disabled || questionIndex === 0} aria-label={`質問 ${questionIndex + 1} を上へ`} onClick={() => {
            const bookingQuestions = [...offer.bookingQuestions]; [bookingQuestions[questionIndex - 1], bookingQuestions[questionIndex]] = [bookingQuestions[questionIndex]!, bookingQuestions[questionIndex - 1]!]; updateOffer(index, { bookingQuestions });
          }} className={consoleButtonClass("secondary", "sm", DISABLED)}>質問を上へ</button><button type="button" disabled={disabled || questionIndex === offer.bookingQuestions.length - 1} aria-label={`質問 ${questionIndex + 1} を下へ`} onClick={() => {
            const bookingQuestions = [...offer.bookingQuestions]; [bookingQuestions[questionIndex + 1], bookingQuestions[questionIndex]] = [bookingQuestions[questionIndex]!, bookingQuestions[questionIndex + 1]!]; updateOffer(index, { bookingQuestions });
          }} className={consoleButtonClass("secondary", "sm", DISABLED)}>質問を下へ</button><button type="button" disabled={disabled} aria-label={`質問 ${questionIndex + 1} を外す`} onClick={() => updateOffer(index, { bookingQuestions: offer.bookingQuestions.filter((_, at) => at !== questionIndex) })} className={consoleButtonClass("secondary", "sm", DISABLED)}>{`質問 ${questionIndex + 1} を外す`}</button></div>
        </fieldset>)}
      </div>
    </FieldSection>)}
    <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={disabled || offers.length >= LIVE_OFFER_LIMIT} onClick={addOffer} className={consoleButtonClass("secondary", "md", DISABLED)}>商品を追加</button><span className="text-xs text-muted">最大 {LIVE_OFFER_LIMIT} 件。予約履歴がある商品は保存時に削除できません。</span></div>
  </>;
}
