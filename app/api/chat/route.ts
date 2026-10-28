// ═══════════════════════════════════════════════════════════════════════════
// POST /api/chat — RAG generation step for a single chat turn.
//
// External-source handling (PRD §5.6–§5.8) is delegated to lib/rag/chatFlow.ts. The
// "insufficient evidence" judgment is now made by the model itself via a
// marker string (NEED_EXTERNAL_MARKER, see chat.ts) rather than a pre-LLM
// zero-chunks check — that old check wrongly hijacked casual messages like
// "hi" into the external-search offer flow. Generation modes (Summary/
// Flashcards/Quiz/Exam) are forced to knowledgeMode='materials_only' at the
// prompt level regardless of the subject's actual setting, so they never
// even get instructed to emit the marker.
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { searchChunks, broadSample } from '@/lib/rag/retrieve';
import {
  extractPracticeResult,
  type ChatMode, type KnowledgeMode, type ChatTurn,
} from '@/lib/rag/chat';
import { resolveChatAnswer } from '@/lib/rag/chatFlow';
import { tryConsumeLimit, limitExceededMessage, RateLimitUnavailableError } from '@/lib/rag/rateLimit';
import { updateProgress, getWeakTopics } from '@/lib/rag/progress';
import { apiAuthFailure, getApiUser } from '@/lib/supabase/api-auth';

const CONVERSATIONAL_MODES: ChatMode[] = ['tutor', 'practice'];
const GENERATION_MODES: ChatMode[] = ['summary', 'flashcards', 'quiz', 'exam'];

export async function POST(request: Request) {
  const supabase = createClient();
  const { user, error: authError } = await getApiUser(supabase);
  if (!user) return apiAuthFailure(authError);

  const body = await request.json();
  const { chat_id, subject_id, question, history = [] } = body as {
    chat_id: string; subject_id: string; question: string; history?: ChatTurn[];
  };

  if (!question?.trim()) return NextResponse.json({ detail: 'Question cannot be empty.' }, { status: 400 });

  // Abuse-protection rate limit — checked before any DB writes or LLM calls
  // happen, so a rejected request costs nothing beyond this one lookup.
  let chatLimit;
  try {
    chatLimit = await tryConsumeLimit(supabase, user.id, 'chat_message');
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      return NextResponse.json({ detail: error.message }, { status: 503 });
    }
    throw error;
  }
  if (!chatLimit.allowed) {
    return NextResponse.json({ detail: limitExceededMessage('chat_message') }, { status: 429 });
  }

  const [{ data: subject }, { data: chat }, { count: readyDocCount }, { data: settings }] = await Promise.all([
    supabase.from('subjects').select('id, name, knowledge_mode').eq('id', subject_id).single(),
    supabase.from('chats').select('id, mode, subject_id').eq('id', chat_id).eq('subject_id', subject_id).single(),
    // head:true fetches zero rows — we only ever need the count, not the
    // actual document data, so there's no reason to transfer every row.
    supabase.from('documents').select('id', { count: 'exact', head: true }).eq('subject_id', subject_id).eq('status', 'ready'),
    supabase.from('user_settings').select('knowledge_mode').eq('user_id', user.id).single(),
  ]);

  if (!subject) return NextResponse.json({ detail: 'Subject not found.' }, { status: 404 });
  if (!chat) return NextResponse.json({ detail: 'Chat not found for this subject.' }, { status: 404 });

  const hasDocs = (readyDocCount ?? 0) > 0;
  const rawKnowledgeMode: KnowledgeMode =
    (subject.knowledge_mode as KnowledgeMode) || (settings?.knowledge_mode as KnowledgeMode) || 'ask_before_external';
  const mode = (chat.mode as ChatMode) || 'tutor';

  // Generation modes stay materials-only at the PROMPT level regardless of
  // the subject's real knowledge mode — they shouldn't ever be instructed
  // to emit the external-source marker in the first place.
  const knowledgeMode: KnowledgeMode = GENERATION_MODES.includes(mode) ? 'materials_only' : rawKnowledgeMode;

  const { error: userMessageError } = await supabase
    .from('messages')
    .insert({ chat_id, user_id: user.id, role: 'user', content: question });
  if (userMessageError) {
    return NextResponse.json({ detail: 'Could not save your message. Please try again.' }, { status: 500 });
  }

  try {
    let chunks = hasDocs
      ? await searchChunks(supabase, question, subject_id, user.id, GENERATION_MODES.includes(mode) ? 10 : 5)
      : [];
    if (hasDocs && GENERATION_MODES.includes(mode) && chunks.length < 3) {
      chunks = await broadSample(supabase, subject_id, user.id, 20);
    }

    // Weak-topic personalization (PRD §7) — only meaningful for the two
    // conversational modes; Quiz/Exam/Summary/Flashcards don't need it.
    const weakTopics = CONVERSATIONAL_MODES.includes(mode)
      ? await getWeakTopics(supabase, user.id, subject_id, 3)
      : [];

    const resolved = await resolveChatAnswer({
      supabase,
      userId: user.id,
      subjectName: subject.name,
      mode,
      knowledgeMode,
      question,
      history,
      chunks,
      hasDocs,
      weakTopics,
    });
    let { answer } = resolved;

    // ── Practice mode: strip the hidden result marker, update progress ────
    // The student never sees the raw marker — this is what lets a plain
    // conversation still feed the same student_progress signal Quiz/Exam do.
    let practiceResult: { topic: string; correct: boolean } | null = null;
    if (mode === 'practice') {
      const extracted = extractPracticeResult(answer);
      if (extracted) {
        answer = extracted.cleaned;
        practiceResult = { topic: extracted.topic, correct: extracted.correct };
      }
    }

    const { data: savedMsg, error: saveError } = await supabase
      .from('messages')
      .insert({ chat_id, user_id: user.id, role: 'assistant', content: answer, source_type: resolved.sourceType })
      .select('id, created_at').single();
    if (saveError || !savedMsg) throw new Error('Could not save the tutor response. Please try again.');

    const seen = new Set<string>();
    const citationRows: any[] = [];
    for (const c of chunks) {
      const key = `doc-${c.documentId}-${c.page}-${c.section ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citationRows.push({ message_id: savedMsg!.id, kind: 'document', document_id: c.documentId, filename: c.filename, page: c.page, section: c.section });
    }
    for (const ec of resolved.externalCitations) {
      citationRows.push({ message_id: savedMsg!.id, kind: ec.kind, title: ec.title, url: ec.url, channel: ec.channel ?? null, timestamp_s: ec.timestamp_s ?? null });
    }
    if (citationRows.length) await supabase.from('citations').insert(citationRows);

    await supabase.from('chats').update({ last_active_at: new Date().toISOString() }).eq('id', chat_id);

    let progressWarning = false;
    if (practiceResult) {
      try {
        await updateProgress(supabase, user.id, subject_id, practiceResult.topic, practiceResult.correct ? 1 : 0);
      } catch {
        progressWarning = true;
      }
      // Lightweight session record so practice attempts show up in the
      // same history the progress dashboard uses for quiz/exam sessions.
      await supabase.from('study_sessions').insert({
        chat_id, subject_id, user_id: user.id, mode: 'practice',
        score: practiceResult.correct ? 1 : 0, total: 1,
        topic_breakdown: { [practiceResult.topic]: { correct: practiceResult.correct ? 1 : 0, total: 1 } },
        completed_at: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      answer,
      created_at: savedMsg.created_at,
      progress_warning: progressWarning,
      sources: citationRows.map((c) => ({ kind: c.kind, filename: c.filename, page: c.page, section: c.section, title: c.title, url: c.url, channel: c.channel, timestamp_s: c.timestamp_s })),
    });
  } catch (err: any) {
    if (err instanceof RateLimitUnavailableError) {
      return NextResponse.json({ detail: err.message }, { status: 503 });
    }
    return NextResponse.json({ detail: err.message || 'AI generation failed.' }, { status: 502 });
  }
}
