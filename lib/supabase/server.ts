import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Server-side Supabase client for use in Route Handlers / Server Components.
// Reads/writes the auth session via cookies, never exposes the service key.
//
// SECURITY NOTE: these cookies are deliberately NOT httpOnly. That's
// intentional, not an oversight — Supabase's browser client reads them
// directly via document.cookie to restore a session without a round-trip
// to the auth server on every navigation. Setting httpOnly here breaks
// that entirely (confirmed against current Supabase SSR guidance). What we
// DO explicitly set: secure (HTTPS-only in production) and sameSite=lax
// (blocks the cookie being sent on cross-site POST requests, which is the
// main practical CSRF defense for the API routes that rely on this session).
const secureCookieOptions: Partial<CookieOptions> = {
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set({ name, value, ...options, ...secureCookieOptions });
            });
          } catch {
            // Server Components cannot write cookies; middleware handles
            // refresh persistence while Route Handlers can write directly.
          }
        },
      },
    },
  );
}
