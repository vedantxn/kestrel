import { NextResponse, type NextRequest } from "next/server";

/** `SESSION_COOKIE` in lib/session; repeated so this file pulls in no crypto. */
const SESSION_COOKIE = "kestrel_session";

/**
 * An optimistic check only: no cookie, no dashboard. Whether the cookie is valid, and whether
 * its key still works, is decided on the server by `requireClient` and the API.
 */
export function proxy(req: NextRequest) {
  if (!req.cookies.has(SESSION_COOKIE))
    return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };
