import { STRIPE_DASHBOARD_URL } from "@/host/payout";
import { HOST_STRIPE_LOGIN_PATH } from "@/lib/host/routes";
import { HostIcon } from "./HostIcon";

/** Opens the generic Express login in previews; live hosts request a server-side, account-specific link. */
export function HostStripeLogin({
  providerId,
  label,
  className,
  formClassName,
}: {
  providerId?: string | null;
  label: string;
  className: string;
  formClassName?: string;
}) {
  const children = (
    <>
      <HostIcon name="external" className="size-3.5" />
      {label}
      <span className="sr-only">（新しいタブで開きます）</span>
    </>
  );

  if (!providerId) {
    return (
      <a href={STRIPE_DASHBOARD_URL} target="_blank" rel="noopener noreferrer" className={[formClassName, className].filter(Boolean).join(" ")}>
        {children}
      </a>
    );
  }

  return (
    <form action={HOST_STRIPE_LOGIN_PATH} method="post" target="_blank" rel="noopener noreferrer" className={formClassName}>
      <input type="hidden" name="providerId" value={providerId} />
      <button type="submit" className={className}>
        {children}
      </button>
    </form>
  );
}
