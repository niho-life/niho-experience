import { NOTIFICATION_ADDRESS_CHANGE_TEXT, NOTIFICATION_LOCKED_TEXT, type NotificationPanelView, type NotificationRow } from "@/host/notifications";
import { NOTIFICATION_ADDRESS_TEXT, type HostNotificationAddressView } from "@/host/notification-address";
import { PREPARING_STATUS } from "@/host/status";
import type { HostNotificationKey } from "@/host/types";
import { FieldRow, FieldSection, SwitchRow } from "./fields";
import { HostNotificationAddress } from "./HostNotificationAddress";

/**
 * 設定 › 通知 (#109, the journey mock's H7): where the emails go and one switch per notification in the spec's order. The
 * ones the host cannot stop are on, locked and say so. The three that can be stopped are kept by the settings form's 保存
 * (the form holds the switches' state). Anyone but the owner reads that the settings are the owner's; when the experience
 * DB cannot be read, the panel says so instead of guessing.
 *
 * 宛先 (#194): once this site emails hosts (`address`, EXPERIENCE_HOST_MAIL_ENABLED, or the preview), everyone signed in
 * sees their own address and may change it here, whatever their role (an operator gets the emails of their product).
 * Until then it is NIHO's, shown as it is and not changed here.
 */
export function HostNotificationPanel({
  view,
  rows,
  onToggle,
  providerId,
  address,
}: {
  view: NotificationPanelView;
  /** The switches as they are on screen (the form keeps them until 保存). */
  rows: readonly NotificationRow[];
  onToggle: (key: HostNotificationKey, enabled: boolean) => void;
  providerId: string;
  /** This person's address for this site's emails; "error" when it could not be read; null while this site sends none. */
  address: HostNotificationAddressView | "error" | null;
}) {
  const addressRow = address === null ? null : (
    <FieldRow label="宛先" labelId="settings-notification-to">
      {address === "error" ? (
        <p role="alert" className="flex min-h-10 items-center text-danger">{NOTIFICATION_ADDRESS_TEXT.loadFailed}</p>
      ) : (
        <HostNotificationAddress providerId={providerId} initial={address} labelId="settings-notification-to" />
      )}
    </FieldRow>
  );
  return (
    <FieldSection id="settings-notification" title="通知" status={view.preparing ? PREPARING_STATUS : null}>
      {view.kind === "owner-only" ? (
        addressRow ? (
          <>
            {addressRow}
            <FieldRow label="届く通知" labelId="settings-notification-items">
              <p className="flex min-h-10 items-center text-ink-soft">{view.text}</p>
            </FieldRow>
          </>
        ) : (
          <p className="flex min-h-10 items-center text-ink-soft">{view.text}</p>
        )
      ) : view.kind === "error" ? (
        <>
          {addressRow}
          <p role="alert" className="flex min-h-10 items-center text-danger">{view.text}</p>
        </>
      ) : (
        <>
          {addressRow ?? (
            <FieldRow label="宛先" labelId="settings-notification-to">
              <div role="group" aria-labelledby="settings-notification-to" className="flex min-h-10 flex-col justify-center gap-0.5">
                {view.addresses.length ? (
                  <ul>
                    {view.addresses.map((item) => (
                      <li key={item} className="font-extrabold [overflow-wrap:anywhere]">
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-ink-soft">{view.addressText}</p>
                <p className="text-xs text-muted">{NOTIFICATION_ADDRESS_CHANGE_TEXT}</p>
              </div>
            </FieldRow>
          )}
          <FieldRow label="届く通知" labelId="settings-notification-items">
            <div role="group" aria-labelledby="settings-notification-items" className="divide-y divide-line md:max-w-[520px]">
              {rows.map((row) => (
                <SwitchRow
                  key={row.key}
                  id={`settings-notification-${row.key}`}
                  label={row.label}
                  detail={row.when}
                  checked={row.enabled}
                  disabled={view.preparing}
                  locked={row.locked ? NOTIFICATION_LOCKED_TEXT : undefined}
                  onChange={(enabled) => onToggle(row.key, enabled)}
                />
              ))}
            </div>
          </FieldRow>
        </>
      )}
    </FieldSection>
  );
}
