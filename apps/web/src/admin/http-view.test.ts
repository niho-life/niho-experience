import { describe, expect, it } from "vitest";
import { adminBookingQuery, EMPTY_ADMIN_HTTP_BOOKING_FILTERS, mergeUniqueBookings } from "./http-view";

describe("Admin HTTP booking query state", () => {
  it("sends search terms only in a JSON-ready body and adds a cursor only for continuation", () => {
    const filters = { ...EMPTY_ADMIN_HTTP_BOOKING_FILTERS, hostSearch: "  工房  ", search: " Synthetic Guest ", support: "legacy" as const };
    expect(adminBookingQuery(filters)).toEqual({ limit: 50, hostSearch: "工房", search: "Synthetic Guest", support: "legacy" });
    expect(adminBookingQuery(filters, "cursor-2")).toEqual({ limit: 50, cursor: "cursor-2", hostSearch: "工房", search: "Synthetic Guest", support: "legacy" });
  });

  it("merges cursor pages by opaque booking id without duplicating prior rows", () => {
    expect(mergeUniqueBookings([{ id: "a", value: 1 }, { id: "b", value: 1 }], [{ id: "b", value: 2 }, { id: "c", value: 1 }])).toEqual([
      { id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 1 },
    ]);
  });
});
