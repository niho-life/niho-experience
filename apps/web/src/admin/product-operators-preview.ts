import "server-only";
import type { ProductOperatorAdminSnapshot } from "@niho-experience/experience-store";

/*
 * 運営者の合成プレビュー (#542): what /admin/operators draws when ADMIN_PRODUCT_OPERATORS_PREVIEW_ENABLED is on in mock
 * mode, for Playwright. Synthetic only: no real names or experiences. Dates are fixed (2020 is always past, 2099 never
 * reached) so that "期限切れ" is stable. The browser's API calls are stubbed by the test; nothing here is saved or sent.
 */

export const PRODUCT_OPERATORS_PREVIEW_IDS = {
  kitchen: { providerId: "provider-sample-kitchen", productId: "product-sample-kitchen-dinner" },
  workshop: { providerId: "provider-sample-workshop", productId: "product-sample-craft-workshop" },
  tea: { providerId: "provider-sample-kitchen", productId: "product-sample-tea-hour" },
  invitationPending: "7b1f0a52-3c64-4d8e-9a1b-2c3d4e5f6a01",
  invitationExpired: "7b1f0a52-3c64-4d8e-9a1b-2c3d4e5f6a02",
  invitationRevoked: "7b1f0a52-3c64-4d8e-9a1b-2c3d4e5f6a03",
  userKitchen: "11111111-1111-4111-8111-111111111111",
  userTea: "22222222-2222-4222-8222-222222222222",
  userGone: "33333333-3333-4333-8333-333333333333",
} as const;

const ids = PRODUCT_OPERATORS_PREVIEW_IDS;
const kitchen = { ...ids.kitchen, productTitle: "Sample Kitchen Dinner", sellerDisplayName: "サンプルの台所" };
const workshop = { ...ids.workshop, productTitle: "Sample Craft Workshop", sellerDisplayName: "サンプル工房" };
const tea = { ...ids.tea, productTitle: "Sample Tea Hour", sellerDisplayName: "サンプルの台所" };

export function productOperatorsPreview(): ProductOperatorAdminSnapshot {
  return {
    products: [kitchen, workshop, tea],
    invitations: [
      { ...kitchen, id: ids.invitationPending, assignmentLabel: "合成 招待A", state: "PENDING", expiresAtUtc: "2099-12-24T00:00:00.000Z", revision: 1, createdAtUtc: "2026-11-01T00:00:00.000Z" },
      { ...tea, id: ids.invitationExpired, assignmentLabel: "合成 招待B", state: "PENDING", expiresAtUtc: "2020-01-08T00:00:00.000Z", revision: 1, createdAtUtc: "2020-01-01T00:00:00.000Z" },
      { ...tea, id: ids.invitationRevoked, assignmentLabel: "合成 失効済みC", state: "REVOKED", expiresAtUtc: "2099-12-24T00:00:00.000Z", revokedAtUtc: "2026-11-02T00:00:00.000Z", revision: 2, createdAtUtc: "2026-11-01T00:00:00.000Z" },
    ],
    grants: [
      { ...kitchen, nihoUserId: ids.userKitchen, assignmentLabel: "合成 担当A", active: true, version: 3, grantedAtUtc: "2026-10-20T00:00:00.000Z" },
      { ...tea, nihoUserId: ids.userTea, assignmentLabel: "合成 担当D", active: true, expiresAtUtc: "2099-12-31T00:00:00.000Z", version: 1, grantedAtUtc: "2026-10-21T00:00:00.000Z" },
      { ...tea, nihoUserId: ids.userGone, assignmentLabel: "合成 解除済みE", active: false, version: 4, grantedAtUtc: "2026-10-01T00:00:00.000Z", revokedAtUtc: "2026-10-15T00:00:00.000Z" },
    ],
  };
}
