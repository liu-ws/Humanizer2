export function Icon({
  kind,
}: {
  kind: "document" | "overview" | "chat" | "plus" | "sun" | "moon" | "language";
}) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "sun" ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      ) : kind === "moon" ? (
        <path d="M20.5 13A8.7 8.7 0 0 1 11 3.5 8.8 8.8 0 1 0 20.5 13Z" />
      ) : kind === "language" ? (
        <>
          <path d="M3 6h11M8.5 3v3M12 6c-1 5-4 8-9 10M5 8c1 3 4 6 7 7M13 21l4-11 4 11M14.5 17h5" />
        </>
      ) : kind === "document" ? (
        <>
          <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
          <path d="M14 3v5h5M9 12h6M9 16h6" />
        </>
      ) : kind === "overview" ? (
        <>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 7h8M8 11h8M8 15h5" />
        </>
      ) : kind === "chat" ? (
        <path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />
      ) : (
        <path d="M12 5v14M5 12h14" />
      )}
    </svg>
  );
}
