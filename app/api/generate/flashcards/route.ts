import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { retrieveGenerationChunks } from '@/lib/rag/retrieve';
import { generateFlashcards } from '@/lib/rag/generate';
import { apiAuthFailure, getApiUser } from '@/lib/supabase/api-auth';
import { getGenerationContext } from '@/lib/supabase/generation-context';

export async function POST(request: Request) {
  const supabase = createClient();
  const { user, error: authError } = await getApiUser(supabase);
  if (!user) return apiAuthFailure(authError);

  const { chat_id, subject_id, topic } = await request.json();
  const { subject, chat } = await getGenerationContext(supabase, user.id, subject_id, chat_id);
  if (!subject) return NextResponse.json({ detail: 'Subject not found.' }, { status: 404 });
  if (!chat) return NextResponse.json({ detail: 'Chat not found for this subject.' }, { status: 404 });

  try {
    const chunks = await retrieveGenerationChunks(supabase, subject_id, user.id, topic);
    if (!chunks.length) {
      return NextResponse.json({ detail: 'No ready study materials found. Upload a supported file first.' }, { status: 422 });
    }

    const { data: priorSets } = await supabase
      .from('flashcard_sets').select('cards').eq('subject_id', subject_id).eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(6);
    const avoidFronts = (priorSets ?? [])
      .flatMap((s) => (s.cards as any[]).map((c) => c.front))
      .slice(0, 60);

    const cards = await generateFlashcards(subject.name, chunks, 12, avoidFronts);
    if (!cards.length) throw new Error('The AI did not return any flashcards. Try again.');

    const { data: set, error } = await supabase
      .from('flashcard_sets')
      .insert({ chat_id, subject_id, user_id: user.id, title: topic?.trim() ? `Flashcards: ${topic}` : 'Flashcards', cards })
      .select().single();
    if (error) throw new Error(error.message);

    return NextResponse.json({ set });
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || 'Failed to generate flashcards.' }, { status: 502 });
  }
}
