import type { ReactNode } from 'react';

export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p className="form-error">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <circle cx="12" cy="16" r="0.1" fill="currentColor" stroke="currentColor" strokeWidth="2" />
      </svg>
      {children}
    </p>
  );
}
