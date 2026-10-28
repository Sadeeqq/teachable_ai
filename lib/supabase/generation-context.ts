import type { SupabaseClient } from '@supabase/supabase-js';

export async function getGenerationContext(
  supabase: SupabaseClient,
  userId: string,
  subjectId: string,
  chatId: string,
) {
  const [{ data: subject }, { data: chat }] = await Promise.all([
    supabase.from('subjects').select('id, name')
      .eq('id', subjectId).eq('user_id', userId).maybeSingle(),
    supabase.from('chats').select('id')
      .eq('id', chatId).eq('subject_id', subjectId).eq('user_id', userId).maybeSingle(),
  ]);
  return { subject, chat };
}
