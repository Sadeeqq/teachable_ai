// ═══════════════════════════════════════════════════════════════════════════
// progress.ts — shared student_progress update logic (PRD §7).
// Extracted from app/api/assessment/submit/route.ts so Practice mode can
// write to the same rolling per-topic signal without duplicating the blend
// formula. "Rolling" matters: a single bad quiz shouldn't erase a topic the
// student is generally strong in, so new evidence is blended in rather than
// overwriting the existing strength outright.
// ═══════════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js';

export async function updateProgress(
  supabase: SupabaseClient,
  userId: string,
  subjectId: string,
  topic: string,
  ratio: number, // 0..1 — how well they did on this specific piece of evidence
) {
  const { error } = await supabase.rpc('record_student_progress', {
    p_user_id: userId,
    p_subject_id: subjectId,
    p_topic: topic,
    p_ratio: ratio,
  });
  if (error) {
    console.error('[progress] Could not update topic progress:', error.message);
    throw new Error('Could not update learning progress.');
  }
}

// Weak topics for personalization (PRD §7: "recommend targeted review").
// Returns the lowest-strength topics with enough attempts to be meaningful
// — a single unlucky guess shouldn't immediately brand a topic "weak".
export async function getWeakTopics(
  supabase: SupabaseClient,
  userId: string,
  subjectId: string,
  limit = 3,
) {
  const { data } = await supabase
    .from('student_progress').select('topic, strength, attempts')
    .eq('user_id', userId).eq('subject_id', subjectId)
    .gte('attempts', 2)
    .lt('strength', 0.65)
    .order('strength', { ascending: true })
    .limit(limit);
  return data ?? [];
}
