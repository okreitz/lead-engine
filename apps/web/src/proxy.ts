/**
 * Login gate for every page (CLAUDE.md "Bind and auth"). Without a session cookie, any page
 * except /login redirects to /login. This is an optimistic check; the engine validates the
 * session on every API call, so a forged or expired cookie gets no data. The `/api/v1` proxy
 * is excluded because the engine answers 401 itself.
 */
import { SESSION_COOKIE } from '@le/shared';
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const login = new URL('/login', request.url);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the login page, the API proxy and static assets.
  matcher: ['/((?!login|api/|_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
