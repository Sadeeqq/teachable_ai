import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// See lib/supabase/server.ts for why these are NOT httpOnly — Supabase's
// browser client needs to read them directly. secure/sameSite are still
// explicitly enforced here rather than left to library defaults.
const secureCookieOptions: Partial<CookieOptions> = {
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

// Protect dashboard pages and refresh their Supabase session cookie. API
// handlers verify their own sessions so each request performs one auth check.
export async function middleware(request: NextRequest) {
  const isApiRoute = request.nextUrl.pathname.startsWith('/api/');

  // Every API handler verifies its own user before doing any work. Avoid a
  // second getUser() network request here: it can fail independently and
  // reject a valid API call before its handler gets a chance to verify the
  // same session. Keep the CSRF origin check at the middleware boundary.
  if (isApiRoute) {
    const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (isStateChanging) {
      const origin = request.headers.get('origin');
      if (origin && origin !== request.nextUrl.origin) {
        return NextResponse.json({ detail: 'Request origin mismatch.' }, { status: 403 });
      }
    }
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          // Make refreshed auth cookies visible to downstream route handlers
          // during this request, then also send them back to the browser.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set({ name, value, ...options, ...secureCookieOptions });
          });
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  const isAuthRoute = request.nextUrl.pathname.startsWith('/auth');
  const isProtectedPage = request.nextUrl.pathname.startsWith('/dashboard');

  if (!user && isProtectedPage) {
    return NextResponse.redirect(new URL('/auth', request.url));
  }
  if (user && isAuthRoute) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
