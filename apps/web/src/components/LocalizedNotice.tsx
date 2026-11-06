"use client";

import type { ComponentProps } from "react";
import { NoticeV1 } from "@niho/experience-presentation/v1";
import { useSiteCopy } from "./SiteLocale";

/** NoticeV1 with the page's own copy for its label (お知らせ / ご注意 / 問題 / 完了 on a Japanese page, never "Note"). A `copy` prop still wins. */
export function LocalizedNotice(props: ComponentProps<typeof NoticeV1>) {
  const copy = useSiteCopy();
  return <NoticeV1 copy={copy} {...props} />;
}
