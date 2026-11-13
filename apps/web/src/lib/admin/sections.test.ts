import { describe, expect, it } from "vitest";
import { adminBackLink, adminHomePath, adminSections, isAdminSectionActive, NO_ADMIN_SECTION_FLAGS, type AdminSectionFlags } from "./sections";

const ALL: AdminSectionFlags = { bookingSupport: true, siteBookings: true, notifications: true, inquiries: true, people: true, products: true, operators: true, preparations: true, channels: true };

describe("adminSections", () => {
  it("lists every section in the menu order", () => {
    expect(adminSections(ALL).map((section) => section.label)).toEqual(["予約支援", "予約", "通知", "相談", "提供者", "街の人", "運営者", "掲載準備", "掲載先"]);
    expect(adminSections(ALL).map((section) => section.href)).toEqual([
      "/admin/bookings", "/admin/site-bookings", "/admin/notifications", "/admin/inquiries", "/admin/products", "/admin/people", "/admin/operators", "/admin/preparations", "/admin/channels",
    ]);
  });

  it("shows only 予約・提供者・街の人・運営者 for a Google sign-in", () => {
    const google = { ...ALL, bookingSupport: false, notifications: false, inquiries: false, preparations: false, channels: false };
    expect(adminSections(google).map((section) => section.key)).toEqual(["site-bookings", "products", "people", "operators"]);
  });

  it("is empty when nothing is available", () => {
    expect(adminSections(NO_ADMIN_SECTION_FLAGS)).toEqual([]);
  });
});

describe("adminHomePath", () => {
  it("is booking support when it is available", () => {
    expect(adminHomePath(ALL)).toBe("/admin/bookings");
  });
  it("is the first available section otherwise", () => {
    expect(adminHomePath({ ...NO_ADMIN_SECTION_FLAGS, products: true, operators: true })).toBe("/admin/products");
    expect(adminHomePath({ ...ALL, bookingSupport: false })).toBe("/admin/site-bookings");
  });
  it("is null when there is no section", () => {
    expect(adminHomePath(NO_ADMIN_SECTION_FLAGS)).toBeNull();
  });
});

describe("isAdminSectionActive", () => {
  it("matches the section and the pages under it, not a longer name", () => {
    expect(isAdminSectionActive("/admin/bookings", "/admin/bookings")).toBe(true);
    expect(isAdminSectionActive("/admin/bookings/abc", "/admin/bookings")).toBe(true);
    expect(isAdminSectionActive("/admin/bookings-extra", "/admin/bookings")).toBe(false);
  });
});

describe("adminBackLink", () => {
  it("is 提供者 on the page of one provider only", () => {
    expect(adminBackLink("/admin/products/provider-sample-kitchen")).toEqual({ href: "/admin/products", label: "提供者" });
    expect(adminBackLink("/admin/products/provider-sample-kitchen/")).not.toBeNull();
    expect(adminBackLink("/admin/products")).toBeNull();
    expect(adminBackLink("/admin/products/provider-sample-kitchen/new")).toBeNull();
    expect(adminBackLink("/admin/operators")).toBeNull();
  });
});
