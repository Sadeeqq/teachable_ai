// ═══════════════════════════════════════════════════════════════════════════
// generate.ts — structured content generation for Flashcards / Quiz / Exam.
// Unlike the conversational Tutor engine (chat.ts), these produce real
// structured data (question objects, correct answers) so the UI can render
// an actual interactive assessment and grade it — not just markdown text.
//
// Dedup note: telling the model "don't repeat these" in the prompt is only
// a soft ask — it visibly doesn't hold up reliably in practice, especially
// on a small document where there's limited distinct material to draw from.
// So generation now HARD-FILTERS output against prior questions/cards after
// the fact (see isNearDuplicate) and does one backfill call for whatever
// got filtered out, rather than trusting the instruction alone.
// ═══════════════════════════════════════════════════════════════════════════

import type { RetrievedChunk } from './retrieve';
import { buildContextBlock } from './chat';
import { chatComplete } from './llm';

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(stripCodeFences(raw)) as T;
  } catch (err) {
    throw new Error(`The AI's ${label} response wasn't valid JSON — try generating again. (${(err as Error).message})`);
  }
}

// The Groq-retry-without-json-mode and cross-provider fallback both now
// live centrally in chatComplete() — this used to duplicate that logic
// locally before llm.ts existed.
async function callJson(systemPrompt: string, userPrompt: string, temperature = 0.4): Promise<string> {
  const { text } = await chatComplete({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    maxTokens: 4000,
    jsonMode: true,
  });
  return text;
}

// ── Near-duplicate detection ──────────────────────────────────────────────
// Normalized exact match OR high word-overlap (Jaccard similarity) counts
// as a duplicate — catches both literal repeats and lightly-reworded ones
// ("What does X do?" vs "What is the function of X?").
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function isNearDuplicate(a: string, b: string): boolean {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && intersection / union > 0.7;
}

function filterOutDuplicates<T>(items: T[], getText: (item: T) => string, avoid: string[]): T[] {
  return items.filter((item) => !avoid.some((a) => isNearDuplicate(getText(item), a)));
}

// ── Flashcards ────────────────────────────────────────────────────────────
export interface Flashcard {
  id: string;
  front: string;
  back: string;
  citation: { filename: string; page: number | null; section: string | null };
}

async function generateFlashcardsRaw(
  subjectName: string,
  chunks: RetrievedChunk[],
  count: number,
  avoidFronts: string[],
): Promise<Flashcard[]> {
  const avoidBlock = avoidFronts.length
    ? `\n\nDo NOT repeat or closely rephrase any of these already-used flashcard fronts:\n${avoidFronts.map((f) => `- ${f}`).join('\n')}`
    : '';

  const system = `You generate flashcards for a student studying "${subjectName}", strictly from the provided context — never invent facts not in it.
Respond with ONLY a JSON object of the exact shape:
{"cards": [{"front": "question or term", "back": "answer or definition", "source_index": 1}]}
"source_index" must be the [Source N] number the card came from. Generate up to ${count} cards covering DIFFERENT parts of the context, not just the beginning. No commentary, no markdown fences.${avoidBlock}`;

  const user = `═══ CONTEXT ═══\n${buildContextBlock(chunks)}\n═══ END CONTEXT ═══\n\nGenerate the flashcards now.`;

  const raw = await callJson(system, user, 0.85);
  const parsed = parseJson<{ cards: { front: string; back: string; source_index: number }[] }>(raw, 'flashcards');

  return (parsed.cards ?? []).map((c, i) => {
    const src = chunks[(c.source_index ?? 1) - 1] ?? chunks[0];
    return {
      id: `card_${i}`,
      front: c.front,
      back: c.back,
      citation: { filename: src?.filename ?? 'Unknown', page: src?.page ?? null, section: src?.section ?? null },
    };
  });
}

export async function generateFlashcards(
  subjectName: string,
  chunks: RetrievedChunk[],
  count = 12,
  avoidFronts: string[] = [],
): Promise<Flashcard[]> {
  let cards = await generateFlashcardsRaw(subjectName, chunks, count, avoidFronts);
  cards = filterOutDuplicates(cards, (c) => c.front, avoidFronts);

  // Backfill once if filtering dropped too many — ask for exactly the
  // shortfall, with everything seen so far (prior + this call's survivors)
  // added to the avoid list so the retry can't re-duplicate either.
  if (cards.length < count) {
    const shortfall = count - cards.length;
    const expandedAvoid = [...avoidFronts, ...cards.map((c) => c.front)];
    try {
      let extra = await generateFlashcardsRaw(subjectName, chunks, shortfall, expandedAvoid);
      extra = filterOutDuplicates(extra, (c) => c.front, expandedAvoid);
      cards = [...cards, ...extra.slice(0, shortfall)];
    } catch { /* keep whatever we already have — a shorter deck beats a broken one */ }
  }

  return cards.map((c, i) => ({ ...c, id: `card_${i}` }));
}

// ── Quiz / Exam questions ────────────────────────────────────────────────
export interface AssessmentQuestion {
  id: string;
  type: 'multiple_choice' | 'short_answer';
  prompt: string;
  options?: string[];
  correct_answer: string;
  explanation: string;
  topic: string;
  citation: { filename: string; page: number | null; section: string | null };
}

async function generateAssessmentRaw(
  subjectName: string,
  mode: 'quiz' | 'exam',
  chunks: RetrievedChunk[],
  questionCount: number,
  avoidPrompts: string[],
): Promise<AssessmentQuestion[]> {
  const avoidBlock = avoidPrompts.length
    ? `\n\nDo NOT repeat or closely rephrase any of these already-used questions (they may be from a previous quiz OR exam on this same subject — avoid both):\n${avoidPrompts.map((p) => `- ${p}`).join('\n')}`
    : '';

  const system = `You write a ${mode} for a student studying "${subjectName}", strictly from the provided context — never invent facts not in it.
Respond with ONLY a JSON object of the exact shape:
{"questions": [{"type": "multiple_choice", "prompt": "...", "options": ["A","B","C","D"], "correct_answer": "the exact text of the correct option", "explanation": "why, citing the context", "topic": "short topic label", "source_index": 1}]}
Mix "multiple_choice" (4 options) and a few "short_answer" (omit "options", correct_answer is the expected short answer) questions. Generate exactly ${questionCount} questions spanning DIFFERENT parts of the context. "source_index" is the [Source N] number each question is drawn from. No commentary, no markdown fences.${avoidBlock}`;

  const user = `═══ CONTEXT ═══\n${buildContextBlock(chunks)}\n═══ END CONTEXT ═══\n\nGenerate the ${mode} now.`;

  const raw = await callJson(system, user, 0.85);
  const parsed = parseJson<{ questions: any[] }>(raw, mode);

  return (parsed.questions ?? []).map((q, i) => {
    const src = chunks[(q.source_index ?? 1) - 1] ?? chunks[0];
    return {
      id: `q_${i}`,
      type: q.type === 'short_answer' ? 'short_answer' : 'multiple_choice',
      prompt: q.prompt,
      options: q.options,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      topic: q.topic || subjectName,
      citation: { filename: src?.filename ?? 'Unknown', page: src?.page ?? null, section: src?.section ?? null },
    };
  });
}

export async function generateAssessment(
  subjectName: string,
  mode: 'quiz' | 'exam',
  chunks: RetrievedChunk[],
  questionCount = 8,
  avoidPrompts: string[] = [],
): Promise<AssessmentQuestion[]> {
  let questions = await generateAssessmentRaw(subjectName, mode, chunks, questionCount, avoidPrompts);
  questions = filterOutDuplicates(questions, (q) => q.prompt, avoidPrompts);

  if (questions.length < questionCount) {
    const shortfall = questionCount - questions.length;
    const expandedAvoid = [...avoidPrompts, ...questions.map((q) => q.prompt)];
    try {
      let extra = await generateAssessmentRaw(subjectName, mode, chunks, shortfall, expandedAvoid);
      extra = filterOutDuplicates(extra, (q) => q.prompt, expandedAvoid);
      questions = [...questions, ...extra.slice(0, shortfall)];
    } catch { /* keep whatever we already have — fewer fresh questions beats exact repeats */ }
  }

  return questions.map((q, i) => ({ ...q, id: `q_${i}` }));
}

// ── Short-answer grading (batched into one call) ─────────────────────────
export interface GradedAnswer { index: number; correct: boolean; feedback: string; }

export async function gradeShortAnswers(
  items: { index: number; prompt: string; correctAnswer: string; givenAnswer: string }[],
): Promise<GradedAnswer[]> {
  if (!items.length) return [];

  const system = `You grade short-answer quiz responses leniently but fairly — correct if the core idea matches, even with different wording. Respond with ONLY JSON:
{"grades": [{"index": 0, "correct": true, "feedback": "one short sentence"}]}`;

  const user = items.map((it) =>
    `[${it.index}] Question: ${it.prompt}\nExpected: ${it.correctAnswer}\nStudent answered: ${it.givenAnswer}`
  ).join('\n\n');

  const raw = await callJson(system, user);
  const parsed = parseJson<{ grades: GradedAnswer[] }>(raw, 'grading');
  return parsed.grades ?? [];
}
