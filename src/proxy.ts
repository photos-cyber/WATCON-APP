import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic routing only: requests without a session cookie are sent to /login
 * before rendering. The real session + permission checks happen server-side in the
 * Data Access Layer (lib/auth/session.ts) and in every service.
 */
// "/quote" = supplier quote links; the secret token in the URL is checked server-side.
// "/client-quote" = client quotation links (view / verified acceptance); token checked server-side.
const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password", "/api/health", "/quote", "/client-quote"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = request.cookies.has("wc_session");
  // Server Action calls must not be redirected: the client expects an RSC response, and an
  // HTML redirect surfaces as "An unexpected response was received from the server".
  // Every action authenticates itself and returns { ok: false, code: "UNAUTHENTICATED" }.
  const isServerAction = request.method === "POST" && request.headers.has("next-action");
  if (!isPublic && !hasSession && !isServerAction) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    const url = new URL("/login", request.url);
    if (pathname !== "/" && pathname !== "/dashboard") url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Public static assets (files in /public such as the company logos) must be reachable
  // without a session — the login page itself renders the logo.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)"],
};
