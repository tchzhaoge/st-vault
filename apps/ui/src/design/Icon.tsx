import type { ReactNode } from 'react';
const heart = <path d="M12 20 4 12C-2 5 8 1 12 7c4-6 14-2 8 5Z" />;
const paths = {
  network: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M12 7.5v5M5 16.5v-4h14v4" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6" width="12" height="12" rx="3" />
      <path d="m15 10 6-4v12l-6-4Z" />
    </>
  ),
  'hard-drive': (
    <>
      <path d="m3 13 3-8h12l3 8" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 16.5h.01M11 16.5h.01" strokeWidth="2.5" />
    </>
  ),
  play: <path d="m9 5 10 7-10 7Z" fill="currentColor" stroke="none" />,
  pause: <path d="M8 5v14M16 5v14" strokeWidth="3" />,
  volume: (
    <>
      <path d="m11 5-5 4H3v6h3l5 4Z" />
      <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
    </>
  ),
  muted: (
    <>
      <path d="m11 5-5 4H3v6h3l5 4Z" />
      <path d="m16 9 6 6m0-6-6 6" />
    </>
  ),
  expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />,
  collapse: <path d="M3 9h6V3m6 0v6h6M9 21v-6H3m12 6v-6h6" />,
  key: (
    <>
      <circle cx="8" cy="9" r="4" />
      <path d="m11 12 9 9m-3-3 3-3m-6 0 3-3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" fill="var(--panel)" />
      <circle cx="15" cy="17" r="3" fill="var(--panel)" />
    </>
  ),
  language: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z" />
    </>
  ),
  history: (
    <>
      <path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2" />
    </>
  ),
  status: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  logout: (
    <>
      <path d="M10 4H5v16h5m5-12 4 4-4 4m-6-4h10" />
    </>
  ),
  close: <path d="m7 7 10 10M17 7 7 17" />,
  check: <path d="m5 12 4 4L19 6" />,
  edit: <path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15Z" />,
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6m0 4h.01" />
    </>
  ),
  stop: (
    <>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="8" cy="9" r="1.5" />
      <path d="m3 16 5-4 4 3 4-5 5 6" />
    </>
  ),
  'chevron-left': <path d="m14 6-6 6 6 6" />,
  'chevron-right': <path d="m10 6 6 6-6 6" />,
  'link-off': (
    <>
      <path d="M9 16H7a4 4 0 0 1 0-8h2m6 0h2a4 4 0 0 1 0 8h-2M9 12h6" />
      <path d="m4 3 16 18" />
    </>
  ),
  heart,
  'heart-off': (
    <>
      {heart}
      <path d="M3 3l18 18" />
    </>
  ),
  'select-all': (
    <>
      <rect x="7" y="7" width="14" height="14" rx="3" />
      <path d="M16 3H6a3 3 0 0 0-3 3v10m7-2 3 3 5-6" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />,
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof paths;
/** Original project assets; labels belong to the enclosing control. */
export function Icon({ name }: { name: IconName }): JSX.Element {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
