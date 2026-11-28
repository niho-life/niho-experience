import { independentSalesRequest } from "@/lib/experience/independent-sales-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /host/api/products/{productId}/independent-sales?providerId=`: the OWNER chooses 独立 10%（自分の Stripe で販売）for a product (3c-2, #726, docs/host-payouts.md). */
export const POST = independentSalesRequest;
