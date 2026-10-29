import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ProductOperatorInvitation } from "@/components/host/ProductOperatorInvitation";
import { productOperatorRepository } from "@/lib/experience/store-server";
import { decodeOperatorInvitationCookie, OPERATOR_INVITATION_COOKIE } from "@/lib/host/operator-invitation-cookie";
import { hostInvitationLoginPath, invitationIdOrNull } from "@/lib/host/routes";
import { loadHostProviders, readHostSession, requireHostConsole } from "@/lib/host/server";

export const metadata: Metadata = { title: "体験への招待", robots: { index: false, follow: false } };

export default async function InvitationPage({ params }: { params: Promise<{ invitationId: string }> }) {
  requireHostConsole();
  const invitationId = invitationIdOrNull((await params).invitationId);
  if (!invitationId) return <ProductOperatorInvitation invitationId="invalid" prepared={false} loginHref={null} detail={null} />;
  const raw = (await cookies()).get(OPERATOR_INVITATION_COOKIE)?.value;
  const prepared = decodeOperatorInvitationCookie(raw);
  const matches = prepared?.invitationId === invitationId;
  if (!matches) return <ProductOperatorInvitation invitationId={invitationId} prepared={false} loginHref={null} detail={null} />;
  const session = await readHostSession();
  if (!session) return <ProductOperatorInvitation invitationId={invitationId} prepared loginHref={hostInvitationLoginPath(invitationId)} detail={null} />;
  const identity = await loadHostProviders();
  if (identity.status !== "ok") return <ProductOperatorInvitation invitationId={invitationId} prepared loginHref={identity.status === "refresh" || identity.status === "rejected" || identity.status === "signed-out" ? hostInvitationLoginPath(invitationId) : null} detail={null} />;
  const repository = productOperatorRepository();
  let detail = null;
  try {
    const record = repository ? await repository.inspectForIdentity(invitationId, prepared.token, session.nihoUserId) : null;
    if (record) detail = { productTitle: record.productTitle, sellerDisplayName: record.sellerDisplayName, assignmentLabel: record.assignmentLabel };
  } catch { /* The client renders the safe unavailable state without private product data. */ }
  return <ProductOperatorInvitation invitationId={invitationId} prepared loginHref={null} detail={detail} accountName={session.displayName} />;
}
