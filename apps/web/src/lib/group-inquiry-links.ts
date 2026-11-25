import { config } from "@/lib/config";

/** Whether the inquiry feature shows anywhere on the public site: its flag (the mock's preview flag only shows the form). */
export const groupInquiryOpen = (): boolean => config.groupInquiryEnabled;
