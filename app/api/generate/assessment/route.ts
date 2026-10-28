import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { retrieveGenerationChunks } from '@/lib/rag/retrieve';
import { generateAssessment } from '@/lib/rag/generate';
import { apiAuthFailure, getApiUser } from '@/lib/supabase/api-auth';
import { getGenerationContext } from '@/lib/supabase/generation-context';

export async function POST(request: Request) {
  const supabase = createClient();
  const { user, error: authError } = await getApiUser(supabase);
  if (!user) return apiAuthFailure(authError);

  const { chat_id, subject_id, mode, topic, question_count = 8, timed, time_limit_minutes } = await request.json();
  if (mode !== 'quiz' && mode !== 'exam') {
    return NextResponse.json({ detail: 'mode must be quiz or exam.' }, { status: 400 });
  }

  // Guard rails on user-supplied numbers — keep generation cost/time sane
  // and avoid a nonsensical 0-question or 500-minute request.
  const questionCount = Math.min(25, Math.max(3, Number(question_count) || 8));
  const timeLimitMinutes = time_limit_minutes != null ? Math.min(180, Math.max(1, Number(time_limit_minutes))) : null;

  const { subject, chat } = await getGenerationContext(supabase, user.id, subject_id, chat_id);
  if (!subject) return NextResponse.json({ detail: 'Subject not found.' }, { status: 404 });
  if (!chat) return NextResponse.json({ detail: 'Chat not found for this subject.' }, { status: 404 });

  try {
    const chunks = await retrieveGenerationChunks(supabase, subject_id, user.id, topic);
    if (!chunks.length) {
      return NextResponse.json({ detail: 'No ready study materials found. Upload a supported file first.' }, { status: 422 });
    }

    // Pull prior questions from EVERY quiz/exam on this subject (not just
    // this chat, and not just this mode) — a Quiz and an Exam on the same
    // subject were previously drawing from identical broad-sampled chunks
    // and generating near-identical questions, so dedup needs to be
    // cross-mode to actually fix that.
    const { data: priorAssessments } = await supabase
      .from('assessments').select('questions').eq('subject_id', subject_id).eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(6);
    const avoidPrompts = (priorAssessments ?? [])
      .flatMap((a) => (a.questions as any[]).map((q) => q.prompt))
      .slice(0, 60);

    const questions = await generateAssessment(subject.name, mode, chunks, questionCount, avoidPrompts);
    if (!questions.length) throw new Error('The AI did not return any questions. Try again.');

    // Exams always have a timer (PRD §6.6); quizzes only if the student
    // opted in. An explicit minutes value always wins over the fallback
    // formula (question count × 90s ≈ 1.5 min/question).
    const timeLimitSeconds = timeLimitMinutes != null
      ? timeLimitMinutes * 60
      : (mode === 'exam' || timed ? questions.length * 90 : null);

    const { data: assessment, error } = await supabase
      .from('assessments')
      .insert({
        chat_id, subject_id, user_id: user.id, mode,
        title: topic?.trim() ? `${mode === 'exam' ? 'Exam' : 'Quiz'}: ${topic}` : (mode === 'exam' ? 'Exam' : 'Quiz'),
        questions, time_limit_seconds: timeLimitSeconds,
      })
      .select().single();
    if (error) throw new Error(error.message);

    return NextResponse.json({ assessment });
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || 'Failed to generate assessment.' }, { status: 502 });
  }
}
