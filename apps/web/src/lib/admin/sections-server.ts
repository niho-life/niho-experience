import "server-only";
import { config } from "@/lib/config";
import { channelManagerEnabled, channelWorkspacePreviewEnabled } from "@/lib/experience/channel-runtime";
import { isPreparationUiEnabled } from "@/lib/preparations/server";
import { isAdminHttp, isAdminHttpRead, isAdminPreview } from "./server";
import { adminHomePath, adminSections, type AdminSection, type AdminSectionFlags } from "./sections";

/**
 * The menu of the signed-in Admin console (#542): what this sign-in and these flags can use. The layout and the pages
 * that are not available (bookings, notifications, preparations) all ask here, so the menu and the redirects agree.
 */
export function adminSectionFlags(): AdminSectionFlags {
  const preview = isAdminPreview();
  const nihoRead = isAdminHttpRead();
  return {
    bookingSupport: preview || nihoRead,
    siteBookings: preview ? config.adminSiteBookingsPreviewEnabled : config.guestBookingEnabled,
    notifications: preview || nihoRead,
    // 団体・個別の相談 (#532): the inbox page's own condition.
    inquiries: isAdminHttp() && config.groupInquiryEnabled,
    products: preview ? config.adminProductWorkspacesPreviewEnabled : isAdminHttp() && config.experienceHostPublicationApiEnabled,
    operators: preview ? config.adminProductOperatorsPreviewEnabled : config.hostConsoleEnabled,
    preparations: isPreparationUiEnabled(),
    channels: channelManagerEnabled() || channelWorkspacePreviewEnabled(),
  };
}

export function currentAdminSections(): AdminSection[] {
  return adminSections(adminSectionFlags());
}

/** The page to send a person to when the one they opened is not available to them; null when it is the only one or there is none. */
export function adminRedirectFrom(ownHref: string): string | null {
  const home = adminHomePath(adminSectionFlags());
  return home && home !== ownHref ? home : null;
}
