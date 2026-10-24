import type { components } from "../generated/admin-read-openapi.ts";

type Schemas = components["schemas"];

export type ExperienceAdminBookingAnswer = Schemas["ExperienceAdminBookingAnswer"];
export type ExperienceAdminBookingDetail = Schemas["ExperienceAdminBookingDetail"];
export type ExperienceAdminBookingDetailResponse = Schemas["ExperienceAdminBookingDetailResponse"];
export type ExperienceAdminBookingHost = Schemas["ExperienceAdminBookingHost"];
export type ExperienceAdminBookingHostMessage = Schemas["ExperienceAdminBookingHostMessage"];
export type ExperienceAdminBookingListItem = Schemas["ExperienceAdminBookingListItem"];
export type ExperienceAdminBookingListResponse = Schemas["ExperienceAdminBookingListResponse"];
type GeneratedExperienceAdminBookingQuery = Schemas["ExperienceAdminBookingQuery"];
/** The OpenAPI schema makes every query property optional; `default: 50` must not make limit required. */
export type ExperienceAdminBookingQuery = Omit<GeneratedExperienceAdminBookingQuery, "limit"> & { limit?: number };
export type ExperienceAdminBookingStatus = Schemas["ExperienceAdminBookingStatus"];
export type ExperienceAdminNotification = Schemas["ExperienceAdminNotification"];
export type ExperienceAdminNotificationListResponse = Schemas["ExperienceAdminNotificationListResponse"];
export type ExperienceAdminNotificationReadRequest = Schemas["ExperienceAdminNotificationReadRequest"];
export type ExperienceAdminNotificationReadResponse = Schemas["ExperienceAdminNotificationReadResponse"];
export type ExperienceAdminNotificationType = Schemas["ExperienceAdminNotificationType"];
export type ExperienceAdminSupportSnapshotRead = Schemas["ExperienceAdminSupportSnapshotRead"];

export interface ExperienceAdminNotificationQuery {
  cursor?: string;
  unread?: boolean;
  limit?: number;
}
