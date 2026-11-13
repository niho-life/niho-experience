"use client";

import { useId, type ReactNode } from "react";

/** 提供者の種別 (未指定・個人・事業者・団体): the host's KindSegment look, controlled, with the Admin API's values. */
export type ProviderKindValue = "PERSON" | "BUSINESS" | "";

const OPTIONS: { value: ProviderKindValue; label: string }[] = [
  { value: "", label: "未指定" },
  { value: "PERSON", label: "個人" },
  { value: "BUSINESS", label: "事業者・団体" },
];

/** A segmented choice in the host's KindSegment look (a controlled radio group). */
export function SegmentToggle<T extends string>({ label, options, value, disabled = false, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T; disabled?: boolean; onChange: (value: T) => void }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex min-h-10 max-w-full items-center">
      <span className="inline-flex max-w-full flex-wrap rounded-full bg-sand p-0.5">
        {options.map((option) => (
          <label
            key={option.value || "none"}
            className="relative block h-8 rounded-full px-3 text-[0.8125rem] leading-8 font-extrabold whitespace-nowrap text-ink-soft has-[:checked]:bg-canvas has-[:checked]:text-ink has-[:checked]:shadow-[0_1px_2px_rgb(0_0_0/0.08)] has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-moss"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-full opacity-0 focus-visible:outline-none disabled:cursor-default"
            />
            {option.label}
          </label>
        ))}
      </span>
    </div>
  );
}

export function ProviderKindToggle({ value, disabled, onChange }: { value: ProviderKindValue; disabled?: boolean; onChange: (value: ProviderKindValue) => void }) {
  return <SegmentToggle label="提供者の種別" options={OPTIONS} value={value} disabled={disabled} onChange={onChange} />;
}

/** 承諾の checkbox: the sentence is the confirmation itself, so each caller passes it unchanged. */
export function ConsentCheck({ checked, disabled, onChange, children }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-start gap-2.5 text-[0.875rem] leading-[1.5]">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-1 size-4 shrink-0 accent-moss" />
      <span>{children}</span>
    </label>
  );
}

export const PROVIDER_FIELD_LABEL = "block text-[0.78125rem] font-extrabold text-ink-soft";
