import { GOOGLE_NOT_CONNECTED } from "../calendar";
import { NOTIFICATIONS } from "../notifications";
import type { HostBooking, HostCalendarSettings, HostExperience, HostGoogleConnection, HostMeetingDefaults, HostNotificationSettings, HostReview, HostSale, HostThread } from "../types";
import { MOCK_KITCHEN_BOOKINGS } from "./bookings";
import { MOCK_KITCHEN_EXPERIENCES, MOCK_STUDIO_EXPERIENCES } from "./experiences";
import { MOCK_KITCHEN_REVIEWS } from "./reviews";
import { MOCK_KITCHEN_SALES } from "./sales";
import { MOCK_KITCHEN_THREADS } from "./threads";

/*
 * The console's side of the two synthetic providers of the host contract's mock
 * (`@niho-experience/api-client/host/mock`, scenario `two-providers`; same ids): what the
 * contract has no API for yet. The providers' own values, their review and their payout
 * account come from the contract mock itself. Names, URLs and addresses are invented;
 * emails use example.com, and the calendars' colors are the site's own tokens.
 */
export interface MockConsoleProvider {
  experiences: readonly HostExperience[];
  bookings: readonly HostBooking[];
  threads: readonly HostThread[];
  reviews: readonly HostReview[];
  sales: readonly HostSale[];
  meetingPoint: HostMeetingDefaults;
  calendar: HostCalendarSettings;
  notifications: HostNotificationSettings;
}

/** Every notification as NIHO starts it: on, the ones the host cannot stop locked. */
const NOTIFICATIONS_AS_STARTED = NOTIFICATIONS.map(({ key, stoppable }) => ({ key, enabled: true, locked: !stoppable }));

/** Google's own holiday calendar: read for busy times, never written to. */
const HOLIDAYS = { id: "sample-holidays-jp", name: "日本の祝日", color: "#7a4b00", checked: false, writable: false } as const;

/**
 * The Google account the preview's つなぐ connects (the studio's, or any provider's not connected):
 * its own calendar is read for busy times and written to, as Google starts a new connection.
 */
export const MOCK_GOOGLE_CONNECTION: HostGoogleConnection = {
  account: "host@example.com",
  calendars: [
    { id: "sample-host-main", name: "個人の予定", color: "#355e1f", checked: true, writable: true },
    { id: "sample-host-classes", name: "教室の予定", color: "#1e4ea8", checked: false, writable: true },
    HOLIDAYS,
  ],
};

export const MOCK_CONSOLE_PROVIDERS: ReadonlyMap<string, MockConsoleProvider> = new Map<string, MockConsoleProvider>([
  ["sample-provider-kitchen", {
    experiences: MOCK_KITCHEN_EXPERIENCES,
    bookings: MOCK_KITCHEN_BOOKINGS,
    threads: MOCK_KITCHEN_THREADS,
    reviews: MOCK_KITCHEN_REVIEWS,
    sales: MOCK_KITCHEN_SALES,
    meetingPoint: {
      overview: "Near Kamakura Station, 5-minute walk",
      address: "(sample) 1-2-3 Sample-cho, Sample City (fictional)",
      accessNote: "(sample) Leave the station by the east exit and walk along the river toward the sea.",
      mapUrl: "https://maps.example.com/sample-kitchen",
      entranceNote: "Use the side entrance on the right of the building and take the stairs to the second floor. Look for the small sign by the door.",
    },
    // Connected: two of its calendars close the sessions they overlap, bookings go to the kitchen's own.
    calendar: {
      google: {
        status: "connected",
        account: "kitchen@example.com",
        busyCalendars: [
          { id: "sample-kitchen-main", name: "サンプルの台所", color: "#355e1f", checked: true, writable: true },
          { id: "sample-kitchen-family", name: "家族の予定", color: "#1e4ea8", checked: true, writable: true },
          HOLIDAYS,
        ],
        blockBusy: true,
        writeBookings: true,
        writeCalendarId: "sample-kitchen-main",
      },
      icsUrl: "https://calendar.example.com/sample-kitchen/k7f3c9a1e5b2d48c6a0e1f9b3d7c5e2a4/bookings.ics",
    },
    notifications: { email: { addresses: ["kitchen@example.com"] }, items: NOTIFICATIONS_AS_STARTED },
  }],
  // A small second provider: one draft, nothing booked, asked, reviewed or sold yet, no calendar connected.
  ["sample-provider-studio", {
    experiences: MOCK_STUDIO_EXPERIENCES,
    bookings: [],
    threads: [],
    reviews: [],
    sales: [],
    meetingPoint: { overview: "", address: "", accessNote: "", mapUrl: "", entranceNote: "" },
    calendar: { google: GOOGLE_NOT_CONNECTED, icsUrl: "https://calendar.example.com/sample-studio/s2b8e4d0a6c1f37950b2e8d4a6c0f1e3/bookings.ics" },
    notifications: { email: { addresses: ["studio@example.com"] }, items: NOTIFICATIONS_AS_STARTED },
  }],
]);
