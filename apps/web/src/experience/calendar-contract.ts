import type { AvailabilityReason, BusyInterval, Occurrence, ScheduleRule } from "@niho-experience/experience-domain";

export interface HostCalendarData {
  preview: boolean;
  experiences: readonly { id: string; title: string }[];
  rules: readonly (ScheduleRule & { experienceId: string })[];
  occurrences: readonly (Occurrence & { experienceId: string; experienceTitle: string; availableSeats: number; availabilityReason: AvailabilityReason; overrideVersion?: number })[];
  busyIntervals: readonly BusyInterval[];
  google: {
    connected: boolean;
    canManage: boolean;
    blockingEnabled: boolean;
    syncStatus: "FRESH" | "STALE" | "FAILED";
  };
}
