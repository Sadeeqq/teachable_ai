'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export async function createSubject(name: string) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const trimmed = name.trim();
  if (!trimmed) return { error: 'Please enter a subject name.' };

  const { data, error } = await supabase
    .from('subjects').insert({ user_id: user.id, name: trimmed }).select().single();
  if (error) {
    return { error: error.code === '23505' ? `"${trimmed}" already exists.` : error.message };
  }

  // Seed and return the Tutor chat so the client can use it immediately. A
  // subject without this chat renders a composer that cannot send anything.
  const { data: chat, error: chatError } = await supabase
    .from('chats')
    .insert({ subject_id: data.id, user_id: user.id, title: 'General Chat', mode: 'tutor' })
    .select()
    .single();
  if (chatError) {
    // Don't leave a newly-created subject in a partially usable state.
    await supabase.from('subjects').delete().eq('id', data.id);
    return { error: `Subject was created, but its Tutor chat couldn't be initialized: ${chatError.message}` };
  }

  revalidatePath('/dashboard');
  return { subject: data, chat };
}

export async function renameSubject(subjectId: string, name: string) {
  const supabase = createClient();
  const trimmed = name.trim();
  if (!trimmed) return { error: 'Please enter a subject name.' };

  const { data, error } = await supabase
    .from('subjects').update({ name: trimmed }).eq('id', subjectId).select().single();
  if (error) {
    return { error: error.code === '23505' ? `"${trimmed}" already exists.` : error.message };
  }

  revalidatePath('/dashboard');
  return { subject: data };
}

export async function createChat(subjectId: string, mode: string, title: string) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data, error } = await supabase
    .from('chats').insert({ subject_id: subjectId, user_id: user.id, mode, title }).select().single();
  if (error) return { error: error.message };
  revalidatePath('/dashboard');
  return { chat: data };
}

// null = "use my account default" rather than a hard override on this subject.
export async function updateSubjectKnowledgeMode(subjectId: string, mode: string | null) {
  const supabase = createClient();
  const { error } = await supabase.from('subjects').update({ knowledge_mode: mode }).eq('id', subjectId);
  if (error) return { error: error.message };
  revalidatePath('/dashboard');
  return { success: true };
}
