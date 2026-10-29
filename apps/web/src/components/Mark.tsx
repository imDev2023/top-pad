/** Heat's mark: the starter's flag that sends a heat off together, on its pole. */
export function Mark({ className, size = 26 }: { className?: string; size?: number }) {
  return (
    <svg className={className} viewBox="0 0 22 26" width={(size * 22) / 26} height={size} aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="3" height="26" rx="1" fill="var(--fg)" />
      <path d="M3 1H22L18.2 7.5L22 14H3Z" fill="var(--go)" />
    </svg>
  );
}
