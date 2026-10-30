import { MEETING_POINT_FIELDS, MEETING_POINT_LIMITS } from "@/host/meeting-point";
import type { HostMeetingDefaults } from "@/host/types";
import { FIELD_DISABLED, FieldRow, INPUT, NARROW, TEXTAREA } from "./fields";

/*
 * 集合場所's five fields (#89), the same in 設定 › 既定の集合案内 and 体験の編集 › 集合場所. Only the
 * rough place is public; the rest reaches guests whose booking is confirmed. `form` joins the
 * fields to a <form> they sit outside of, so its 保存 checks them.
 */

export const MEETING_POINT_LABELS: Record<keyof HostMeetingDefaults, string> = {
  overview: "公開する大まかな場所",
  address: "住所",
  accessNote: "行き方",
  mapUrl: "地図 URL",
  entranceNote: "入口・当日の案内",
};

const PRIVATE_NOTE = "住所・行き方・地図・入口の案内は、予約が確定した方にだけ届きます。";

export function MeetingPointFields({ idPrefix, value, onChange, form, disabled = false }: { idPrefix: string; value: HostMeetingDefaults; onChange: (value: HostMeetingDefaults) => void; form?: string; disabled?: boolean }) {
  const edit = (field: keyof HostMeetingDefaults, text: string) => onChange({ ...value, [field]: text });
  const common = (field: keyof HostMeetingDefaults) => ({ id: `${idPrefix}-${field}`, form, disabled, maxLength: MEETING_POINT_LIMITS[field], value: value[field] });
  return (
    <>
      <FieldRow label={MEETING_POINT_LABELS.overview} htmlFor={`${idPrefix}-overview`}>
        <input {...common("overview")} aria-describedby={`${idPrefix}-overview-help`} onChange={(event) => edit("overview", event.currentTarget.value)} className={`${INPUT} ${NARROW} ${FIELD_DISABLED}`} />
        <p id={`${idPrefix}-overview-help`} className="mt-1 text-xs text-muted">体験サイトに公開されます。</p>
      </FieldRow>
      <FieldRow label={MEETING_POINT_LABELS.address} htmlFor={`${idPrefix}-address`}>
        <input {...common("address")} onChange={(event) => edit("address", event.currentTarget.value)} className={`${INPUT} ${FIELD_DISABLED}`} />
      </FieldRow>
      <FieldRow label={MEETING_POINT_LABELS.accessNote} htmlFor={`${idPrefix}-accessNote`}>
        <textarea {...common("accessNote")} rows={3} onChange={(event) => edit("accessNote", event.currentTarget.value)} className={`${TEXTAREA} ${FIELD_DISABLED}`} />
      </FieldRow>
      <FieldRow label={MEETING_POINT_LABELS.mapUrl} htmlFor={`${idPrefix}-mapUrl`}>
        <input {...common("mapUrl")} type="url" inputMode="url" placeholder="https://" pattern="https://.+" title="https:// で始まる URL を入力してください" onChange={(event) => edit("mapUrl", event.currentTarget.value)} className={`${INPUT} ${NARROW} ${FIELD_DISABLED}`} />
      </FieldRow>
      <FieldRow label={MEETING_POINT_LABELS.entranceNote} htmlFor={`${idPrefix}-entranceNote`}>
        <textarea {...common("entranceNote")} rows={3} onChange={(event) => edit("entranceNote", event.currentTarget.value)} className={`${TEXTAREA} ${FIELD_DISABLED}`} />
      </FieldRow>
      <p className="border-t border-line pt-3 text-xs text-muted md:pl-[184px]">{PRIVATE_NOTE}</p>
    </>
  );
}

/** The provider's default as it is used (INHERIT): read only, unset values as 未設定. */
export function MeetingPointSummary({ value }: { value: HostMeetingDefaults }) {
  return (
    <dl>
      {MEETING_POINT_FIELDS.map((field) => (
        <div key={field} className="grid gap-1 border-t border-line py-3 first:border-t-0 md:grid-cols-[168px_minmax(0,1fr)] md:gap-x-4">
          <dt className="text-[0.78125rem] font-extrabold text-ink-soft">{MEETING_POINT_LABELS[field]}</dt>
          <dd className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${value[field] ? "" : "text-muted"}`}>{value[field] || "未設定"}</dd>
        </div>
      ))}
    </dl>
  );
}
