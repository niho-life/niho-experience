import { agentSalesRequest } from "@/lib/experience/agent-sales-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /host/api/products/{productId}/agent-sales?providerId=`: the OWNER chooses 代理受領 for a product (#725, docs/host-payouts.md). */
export const POST = agentSalesRequest;
