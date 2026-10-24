import { NOTIFICATION_ADDRESS_CHANGE_TEXT, NOTIFICATION_LOCKED_TEXT, type NotificationPanelView, type NotificationRow } from "@/host/notifications";
import { PREPARING_STATUS } from "@/host/status";
import type { HostNotificationKey } from "@/host/types";
import { FieldRow, FieldSection, SwitchRow } from "./fields";

/**
 * 設定 › 通知 (#109, the journey mock's H7): where NIHO's emails go (read-only: changing the address
 * is not here yet) and one switch per notification in NIHO's order. The ones the host cannot stop
 * are on, locked and say so. The three that can be stopped are kept by the settings form's 保存
 * (the form holds the switches' state). Anyone but the owner reads that the settings are the
 * owner's, as NIHO answers them to the owner only.
 */
export function HostNotificationPanel({
  view,
  rows,
  onToggle,
}: {
  view: NotificationPanelView;
  /** The switches as they are on screen (the form keeps them until 保存). */
  rows: readonly NotificationRow[];
  onToggle: (key: HostNotificationKey, enabled: boolean) => void;
}) {
  return (
    <FieldSection id="settings-notification" title="通知" status={view.preparing ? PREPARING_STATUS : null}>
      {view.kind === "owner-only" ? (
        <p className="flex min-h-10 items-center text-ink-soft">{view.text}</p>
      ) : (
        <>
          <FieldRow label="宛先" labelId="settings-notification-to">
            <div role="group" aria-labelledby="settings-notification-to" className="flex min-h-10 flex-col justify-center gap-0.5">
              {view.addresses.length ? (
                <ul>
                  {view.addresses.map((address) => (
                    <li key={address} className="font-extrabold [overflow-wrap:anywhere]">
                      {address}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-ink-soft">{view.addressText}</p>
              <p className="text-xs text-muted">{NOTIFICATION_ADDRESS_CHANGE_TEXT}</p>
            </div>
          </FieldRow>
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
