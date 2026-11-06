import { LocalizedLink as Link } from "./LocalizedLink";
import type { ComponentProps, ReactNode } from "react";
import { SectionHeadingV1, buttonClassV1, type NoticeV1, type ButtonVariantV1 } from "@niho/experience-presentation/v1";
import { LocalizedNotice } from "./LocalizedNotice";

export const buttonClass = (variant: ButtonVariantV1 = "primary", extra = "") => buttonClassV1(variant, extra);

export function ButtonLink({ variant = "primary", className = "", ...props }: ComponentProps<typeof Link> & { variant?: ButtonVariantV1 }) {
  return <Link className={buttonClassV1(variant, className)} {...props} />;
}

export function Notice(props: ComponentProps<typeof NoticeV1>) {
  return <LocalizedNotice {...props} />;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "muted" }) {
  const styles = {
    neutral: "bg-surface/95 text-ink border-line",
    warn: "bg-warn-pale text-warn border-warn/20",
    muted: "bg-sand text-ink-soft border-line",
  }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-sm font-bold ${styles}`}>{children}</span>;
}

export function SectionHeading(props: ComponentProps<typeof SectionHeadingV1>) {
  return <SectionHeadingV1 {...props} />;
}
