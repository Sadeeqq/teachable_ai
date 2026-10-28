// ═══════════════════════════════════════════════════════════════════════════
// rateLimit.ts — daily per-user quotas (PRD §8, §12).
// Simple Postgres counter rather than an external service like Upstash —
// no extra infra, fits the PRD's zero-recurring-cost goal.
//
// One generic table/function covers all three limit kinds (external search,
// chat messages, uploads) rather than a separate table per limit — chat and
// upload are the newer additions here; external_search was migrated onto
// this same mechanism instead of keeping its own dedicated table.
// ═══════════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js';

export type LimitKind = 'external_search' | 'chat_message' | 'upload';

export class RateLimitUnavailableError extends Error {
  constructor() {
    super('Rate limiting is temporarily unavailable. Please try again shortly.');
    this.name = 'RateLimitUnavailableError';
  }
}

// Deliberately generous for chat/upload — this is abuse protection (stop a
// runaway loop or bot from burning through Groq/storage quota), not a UX
// throttle on normal studying. External search stays tighter since it's a
// genuinely more expensive, easier-to-abuse operation.
const DAILY_LIMITS: Record<LimitKind, number> = {
  external_search: 15,
  chat_message: 300,
  upload: 20,
};

const FRIENDLY_NAME: Record<LimitKind, string> = {
  external_search: 'web searches',
  chat_message: 'messages',
  upload: 'document uploads',
};

export async function tryConsumeLimit(
  supabase: SupabaseClient,
  userId: string,
  kind: LimitKind,
): Promise<{ allowed: boolean }> {
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc('consume_usage_limit', {
    p_user_id: userId,
    p_day: today,
    p_kind: kind,
  });
  if (error || !data?.length) {
    console.error('[rate-limit] Could not consume quota:', error?.message ?? 'No result returned');
    throw new RateLimitUnavailableError();
  }

  return { allowed: (data[0] as { allowed: boolean }).allowed };
}

export function limitExceededMessage(kind: LimitKind): string {
  return `You've reached today's limit of ${DAILY_LIMITS[kind]} ${FRIENDLY_NAME[kind]}. This resets at midnight — try again tomorrow.`;
}
