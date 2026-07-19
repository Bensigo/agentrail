"use client";

import { useEffect } from "react";

/**
 * Root fallback boundary. This catches errors thrown in the root layout itself
 * (where the segment-level error.tsx cannot reach), so it must render its own
 * <html>/<body>. It renders OUTSIDE the root layout, which means globals.css is
 * not guaranteed to be loaded here — styles are inlined so the fallback stays
 * legible and on-brand even in a total failure.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          color: "#202020",
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          fontSize: "0.875rem",
          lineHeight: 1.5,
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "0.75rem",
            maxWidth: "24rem",
            padding: "0 1.5rem",
            textAlign: "center",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "#202020",
            }}
          >
            The console hit an unexpected error.
          </h1>
          <p style={{ margin: 0, fontSize: "0.75rem", color: "#8d8d8d" }}>
            Something went wrong while loading the app. Reloading usually clears
            it.
          </p>
          {error.digest && (
            <p
              style={{
                margin: 0,
                fontSize: "0.625rem",
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                color: "#bbbbbb",
              }}
            >
              Reference: {error.digest}
            </p>
          )}
          <button
            onClick={() => reset()}
            style={{
              marginTop: "0.5rem",
              height: "2rem",
              padding: "0 0.75rem",
              borderRadius: "0.25rem",
              border: "none",
              background: "#ffe629",
              color: "#ffffff",
              fontSize: "0.75rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
