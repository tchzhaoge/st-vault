/** Shared in-place progress indicator for recording and address-key operations. */
export function ProgressRing(): JSX.Element {
  return (
    <svg className="operation-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="8"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="38 13"
      />
    </svg>
  );
}
