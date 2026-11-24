/** Malformed Origin headers are rejected rather than throwing an unhandled 500. */
export function isUploadOriginAllowed(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host === host;
  } catch {
    return false;
  }
}
