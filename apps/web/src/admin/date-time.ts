const japanDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Admin API timestamps are instants; host preview wall-clock strings are separate. */
export function adminDateTime(at: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return "日時を確認できません";
  const instant = new Date(at);
  if (!Number.isFinite(instant.getTime())) return "日時を確認できません";
  return `${japanDateTime.format(instant)} JST`;
}
