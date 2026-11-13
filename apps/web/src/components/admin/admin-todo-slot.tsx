"use client";

import { createContext, useContext, useEffect } from "react";

/**
 * 予約の「要対応」の先頭に置く面（承認待ち など）が、いま何件あるかを一覧へ知らせる。面は page から slot として渡され、
 * 自分の state を持つので、件数は props ではなくここを通す。
 */
export const TodoSlotCountContext = createContext<((source: string, count: number) => void) | null>(null);

export function useTodoSlotCount(source: string, count: number): void {
  const report = useContext(TodoSlotCountContext);
  useEffect(() => { report?.(source, count); }, [report, source, count]);
}
