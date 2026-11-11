/** Round X (Twitter) button pointing at the Garuda Markets profile. */
export const GARUDA_X_URL = "https://x.com/garuda_markets";

export function XMarketsButton({ className = "" }: { className?: string } = {}) {
  return (
    <a
      className={`cta-x ${className}`.trim()}
      href={GARUDA_X_URL}
      target="_blank"
      rel="noopener"
      aria-label="Garuda on X"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </a>
  );
}
