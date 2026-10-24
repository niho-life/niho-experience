import type { ExperienceAdminBookingQuery, ExperienceAdminBookingStatus, ExperienceAdminSupportSnapshotRead } from "@niho-experience/api-client/admin-read";
import type { StatusLabel } from "@/host/status";

export interface AdminHttpBookingFilters {
  hostSearch: string;
  fromDate: string;
  toDate: string;
  status: "" | ExperienceAdminBookingStatus;
  support: "" | "on" | "off" | "legacy";
  attention: "" | "yes" | "no";
  search: string;
}

export const EMPTY_ADMIN_HTTP_BOOKING_FILTERS: AdminHttpBookingFilters = {
  hostSearch: "",
  fromDate: "",
  toDate: "",
  status: "",
  support: "",
  attention: "",
  search: "",
};

export function adminBookingQuery(filters: AdminHttpBookingFilters, cursor?: string): ExperienceAdminBookingQuery {
  const query: ExperienceAdminBookingQuery = { limit: 50 };
  if (cursor) query.cursor = cursor;
  const hostSearch = filters.hostSearch.trim();
  const search = filters.search.trim();
  if (hostSearch) query.hostSearch = hostSearch;
  if (search) query.search = search;
  if (filters.fromDate) query.fromDate = filters.fromDate;
  if (filters.toDate) query.toDate = filters.toDate;
  if (filters.status) query.status = filters.status;
  if (filters.support) query.support = filters.support;
  if (filters.attention) query.attention = filters.attention;
  return query;
}

const STATUS: Record<ExperienceAdminBookingStatus, StatusLabel> = {
  PENDING: { label: "承認待ち", tone: "wait" },
  PAYMENT_PENDING: { label: "支払待ち", tone: "wait" },
  PROVISIONAL: { label: "仮受付", tone: "wait" },
  CONFIRMED: { label: "確定", tone: "ok" },
  DECLINED: { label: "辞退", tone: "stop" },
  EXPIRED: { label: "期限切れ", tone: "draft" },
  CANCELLED: { label: "取消済み", tone: "stop" },
  REFUND_NEEDED: { label: "要返金", tone: "stop" },
};

export function adminHttpBookingStatus(status: ExperienceAdminBookingStatus): StatusLabel {
  return STATUS[status];
}

export function adminHttpSupportLabel(support: ExperienceAdminSupportSnapshotRead): { label: string; className: string } {
  if (support.kind !== "valid") return support.kind === "legacy"
    ? { label: "旧予約・条件未記録", className: "bg-warn-pale text-warn" }
    : { label: "支援条件を確認できません", className: "bg-danger-pale text-danger" };
  return support.snapshot.enabled
    ? { label: "支援ON", className: "bg-leaf-pale text-moss" }
    : { label: "支援OFF", className: "bg-sand text-ink-soft" };
}

export function mergeUniqueBookings<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}
