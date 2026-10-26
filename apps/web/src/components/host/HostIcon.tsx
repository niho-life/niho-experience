/** Filled 20px icons for the host console (menu and small actions). Always decorative: the words sit next to them. */
const PATHS = {
  home: <path d="M10 2.4 2.4 8.9V17a1.1 1.1 0 0 0 1.1 1.1H8v-5.2h4v5.2h4.5A1.1 1.1 0 0 0 17.6 17V8.9z" />,
  experiences: (
    <>
      <rect x="2.5" y="2.5" width="6.4" height="6.4" rx="1.8" />
      <rect x="11.1" y="2.5" width="6.4" height="6.4" rx="1.8" />
      <rect x="2.5" y="11.1" width="6.4" height="6.4" rx="1.8" />
      <rect x="11.1" y="11.1" width="6.4" height="6.4" rx="1.8" />
    </>
  ),
  bookings: <path d="M6 2a1 1 0 0 1 1 1v1h6V3a1 1 0 1 1 2 0v1h.5A2.5 2.5 0 0 1 18 6.5V8H2V6.5A2.5 2.5 0 0 1 4.5 4H5V3a1 1 0 0 1 1-1zM2 9.5h16v6a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 2 15.5z" />,
  calendar: <path d="M5 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zM3 9v8h14V9zm3 2h3v3H6z" />,
  sales: (
    <>
      <rect x="2.5" y="10" width="3.8" height="7.5" rx="1.2" />
      <rect x="8.1" y="6" width="3.8" height="11.5" rx="1.2" />
      <rect x="13.7" y="2.5" width="3.8" height="15" rx="1.2" />
    </>
  ),
  settings: <path d="M2 5.6a1 1 0 0 1 1-1h7.3a2.7 2.7 0 0 1 5.1 0H17a1 1 0 1 1 0 2h-1.6a2.7 2.7 0 0 1-5.1 0H3a1 1 0 0 1-1-1zm0 8.8a1 1 0 0 1 1-1h1.6a2.7 2.7 0 0 1 5.1 0H17a1 1 0 1 1 0 2H9.7a2.7 2.7 0 0 1-5.1 0H3a1 1 0 0 1-1-1z" />,
  chevronRight: <path d="M7.3 4.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.4-1.4L11.6 10 7.3 5.7a1 1 0 0 1 0-1.4z" />,
  chevronLeft: <path d="M12.7 4.3a1 1 0 0 1 0 1.4L8.4 10l4.3 4.3a1 1 0 1 1-1.4 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.4 0z" />,
  chevronDown: <path d="M4.3 7.3a1 1 0 0 1 1.4 0L10 11.6l4.3-4.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 0-1.4z" />,
  chevronUp: <path d="M15.7 12.7a1 1 0 0 1-1.4 0L10 8.4l-4.3 4.3a1 1 0 1 1-1.4-1.4l5-5a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4z" />,
  close: <path d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 0 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4z" />,
  copy: <path d="M7 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 2v8h8V4zM3 7a1 1 0 0 1 1 1v8h8a1 1 0 1 1 0 2H4a2 2 0 0 1-2-2V8a1 1 0 0 1 1-1z" />,
  plus: <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1z" />,
  external: <path d="M11 3a1 1 0 1 1 0-2h6a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V4.4l-7.3 7.3a1 1 0 0 1-1.4-1.4L14.6 3zM3 5a2 2 0 0 1 2-2h3a1 1 0 0 1 0 2H5v10h10v-3a1 1 0 1 1 2 0v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  check: <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4l3.3 3.3 7.3-7.3a1 1 0 0 1 1.4 0z" />,
  lock: <path d="M10 2a4 4 0 0 0-4 4v2h-.5A1.5 1.5 0 0 0 4 9.5v7A1.5 1.5 0 0 0 5.5 18h9a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 8H14V6a4 4 0 0 0-4-4zm-2 6V6a2 2 0 1 1 4 0v2z" />,
} as const;

export type HostIconName = keyof typeof PATHS;

export function HostIcon({ name, className = "size-5" }: { name: HostIconName; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      {PATHS[name]}
    </svg>
  );
}
