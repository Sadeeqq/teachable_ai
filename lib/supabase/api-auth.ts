import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function getApiUser(supabase: SupabaseClient) {
  // getClaims verifies asymmetric Supabase JWTs locally instead of making a
  // /auth/v1/user request on every API call. For legacy symmetric signing
  // keys, the SDK securely falls back to server-side getUser validation.
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId && error && error.name !== 'AuthSessionMissingError') {
    const cause = error.cause;
    console.error('[auth] Supabase user verification failed:', {
      message: error.message,
      cause: cause instanceof Error
        ? { name: cause.name, message: cause.message, code: (cause as NodeJS.ErrnoException).code }
        : cause,
    });
  }
  return { user: userId ? { id: userId } : null, error };
}

export function apiAuthFailure(error: { name?: string } | null) {
  const verificationUnavailable = error?.name === 'AuthRetryableFetchError';
  return NextResponse.json(
    {
      detail: verificationUnavailable
        ? 'Unable to verify your session because Supabase Auth could not be reached. Please try again.'
        : 'Not authenticated.',
    },
    { status: verificationUnavailable ? 503 : 401 },
  );
}
