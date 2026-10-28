// ═══════════════════════════════════════════════════════════════════════════
// chat.ts — shared AI/RAG engine (PRD §7: one engine, mode-specific rules).
//
// Persona rewritten to feel like an actual conversation with a real tutor
// rather than a formal report generator — short replies stay short, casual
// chat is handled naturally, and the "insufficient evidence" judgment is
// made BY THE MODEL (via a marker string) instead of a pre-LLM zero-chunks
// check. Phase 7 adds the same marker-based pattern for Practice mode: the
// model signals whether the student's last answer was correct and on what
// topic, which route.ts strips before display and uses to update
// student_progress — this is what lets a conversational mode still feed
// the structured progress system the way Quiz/Exam do.
// ═══════════════════════════════════════════════════════════════════════════

import { chatComplete } from './llm';
import type { RetrievedChunk } from './retrieve';
import type { WebResult, YoutubeResult } from './external';

export type ChatMode = 'tutor' | 'summary' | 'flashcards' | 'practice' | 'quiz' | 'exam';
export type KnowledgeMode = 'materials_only' | 'ask_before_external' | 'materials_web';

const BASE_PERSONA = `You are Teachable, the student's personal AI tutor for "{subject_name}".

Talk like an actual tutor having a real conversation, not a textbook or a
report generator. Use contractions. Vary your sentence length. React to
what the student actually said instead of restating their question back at
them. If they say something short or casual, reply in kind — a "hey, how's
it going?" doesn't need headers and bullet points, it needs a normal
sentence back. Save structure (headers, numbered lists, bold terms) for
when you're genuinely explaining something substantial step by step.
You know this subject deeply and you hold the student to a real standard,
but you're warm and approachable, not stiff or formal.`;

// ── Practice-mode result marker ───────────────────────────────────────────
// Appended by the model to the END of a normal message, on its own line,
// only on the turn where it just evaluated the student's attempt at a
// practice question. route.ts strips it before the student ever sees it.
export const PRACTICE_RESULT_MARKER_RE = /\n?\[\[PRACTICE_RESULT topic="([^"]*)" correct=(true|false)\]\]\s*$/;

function practiceResultInstruction(subjectName: string): string {
  return `
PROGRESS TRACKING — only on turns where you just evaluated a real attempt
at a practice question (not the turn where you ask the question, not for
casual chat, not for a hint-only reply before they've actually answered):
After your normal reply, on its own new final line, append EXACTLY this
(nothing after it, no extra text):
[[PRACTICE_RESULT topic="short topic label"]] with correct=true or
correct=false depending on whether their attempt was right — literally:
[[PRACTICE_RESULT topic="topic name" correct=true]]
The student never sees this — the system strips it before displaying your
message. Use a short, consistent topic label (e.g. "recursion", not a full
sentence) so it can track their progress across sessions for ${subjectName}.`;
}

const MODE_INSTRUCTIONS: Record<ChatMode, string> = {
  tutor: `MODE: Tutor / General Chat.
- This is an open-ended conversation. Casual side-talk, greetings, "thanks",
  follow-up chatter — all of that is normal and welcome; just respond like a
  person would, briefly, then let the conversation continue naturally.
- For actual subject questions, ground your answer in the material, use
  examples/analogies/step-by-step reasoning as needed, and ask follow-up
  questions or check understanding rather than just lecturing at the student.
- If the student references a specific quiz/exam question (they may paste
  one in, e.g. "explain this question: ..."), treat it as a real request for
  a deeper explanation of that exact question — walk through the reasoning
  fully, don't just restate the original answer/explanation.`,
  summary: `MODE: Summary.
- Summarize the requested documents/topics using only the provided context.
- Offer a concise version first; expand into more detail only if asked.
- Every substantive claim must be traceable to a specific source in the context.`,
  flashcards: `MODE: Flashcards.
- Generate flashcards (front/back pairs) strictly from concepts in the context.
- Format each as "Q: ... / A: ..." on its own line, grouped by topic.
- Do not invent topics that are not covered in the uploaded material.`,
  practice: `MODE: Practice.
- This is a live back-and-forth, like a tutor quizzing a student in person —
  keep it conversational, not clinical.
- Ask exactly ONE question at a time, then wait for the student's answer.
- After they answer: react genuinely (not "Correct!" every time — vary it),
  give a hint if they're off before handing over the explanation, and only
  fully explain once they've had a real attempt.
- Adapt difficulty based on how they're doing in this conversation.
- Do not reveal the answer before the student has attempted it.`,
  quiz: `MODE: Quiz.
- When asked to generate a quiz, produce a defined, numbered set of questions
  (multiple choice or short answer) strictly from the context.
- After the student submits answers, score them and show explanations with
  citations for each question.`,
  exam: `MODE: Exam.
- Produce a structured, numbered question set from the context.
- Do NOT give hints or reveal answers during the exam.
- Only grade and explain after the student submits all answers.`,
};

// ── Insufficient-evidence marker ──────────────────────────────────────────
export const NEED_EXTERNAL_MARKER = '[[NEED_EXTERNAL]]';

function evidenceInstructions(knowledgeMode: KnowledgeMode): string {
  const common = `
EVIDENCE CHECK — only applies to genuine subject-matter questions, never to
casual conversation, greetings, or meta chat about you:
- If the CONTEXT above actually answers the question (even partially), just
  answer normally from it.`;

  switch (knowledgeMode) {
    case 'materials_only':
      return `${common}
- If it's a real subject question the CONTEXT does not cover, say so
  directly and warmly (e.g. "That's not something your uploaded materials
  get into — want to ask about something else, or rephrase?"). Never invent
  an answer. Do not use any special marker; just say it plainly.`;
    case 'materials_web':
    case 'ask_before_external':
    default:
      return `${common}
- If it's a real subject question the CONTEXT does not cover, respond with
  EXACTLY this and nothing else — no punctuation, no explanation, just the
  literal text: ${NEED_EXTERNAL_MARKER}
  The system will handle what happens next. Do not add anything before or
  after it, and do not use it for casual conversation.`;
  }
}

function knowledgeModeInstructions(mode: KnowledgeMode): string {
  switch (mode) {
    case 'materials_only':
      return `KNOWLEDGE MODE: Course Materials Only. Never use outside knowledge, even if you're confident — external sources are disabled entirely in this mode.`;
    case 'materials_web':
      return `KNOWLEDGE MODE: Materials + Web. Prefer the CONTEXT below. If EXTERNAL SOURCES are also provided below, use them, but clearly label which parts of your answer came from the student's materials vs. external sources.`;
    case 'ask_before_external':
    default:
      return `KNOWLEDGE MODE: Ask Before External Sources (default). If EXTERNAL SOURCES are provided below, the student already approved using them this turn — use them and label clearly as external.`;
  }
}

const STRICT_RULES = `
STRICT RULES — follow without exception:
1. Never fabricate citations, page numbers, or content not in the context.
2. When you use context information, reflect exactly what the documents say —
   do not contradict or "correct" the uploaded material.
3. Use the conversation history naturally — follow-ups like "simplify that",
   "give an example", "wait, why?" should feel like a continuous conversation,
   not a fresh Q&A each time.
4. Match your formatting to the moment: short/casual reply → plain sentences,
   no headers or bullets. A real explanation → use Markdown structure
   (headers, bold, numbered steps) because it actually helps there.
5. CONFLICT CHECK: if the context contains material from more than one
   source that disagrees on a material point, do NOT silently pick one.
   State that the uploaded materials disagree, present each claim with its
   source name and page when provided, then explain the discrepancy.
   Similar wording or relevance alone is not a conflict.
6. When citing an uploaded document, use a simple reference such as
   From “filename.pdf” on PDF page 4 when a PDF page is provided, or
   From “filename.docx” when no page is available. Use only the filename
   and provided page in the source label. Do not repeat internal labels
   such as [Source 1] or add a section heading to the citation.`;

function personalizationBlock(weakTopics: { topic: string; strength: number }[]): string {
  if (!weakTopics.length) return '';
  const list = weakTopics.map((t) => `- ${t.topic} (${Math.round(t.strength * 100)}% — based on past quiz/practice performance)`).join('\n');
  return `\n\nPERSONALIZATION (use naturally, don't lecture the student about this list or bring it up unprompted):
This student has historically struggled with these topics in this subject:
${list}
Where genuinely relevant to the current conversation, you can connect
explanations back to these areas, offer a bit of extra reinforcement, or
gently note the connection — but only when it actually fits, not every message.
If the student asks what to review or what to practice next, recommend the
lowest-scoring relevant topic and offer one focused practice question. Don't
bring up scores or label the student as weak unless they ask about progress.`;
}

export function buildContextBlock(chunks: RetrievedChunk[]): string {
  if (!chunks.length) {
    return '(No relevant content was found in the student\'s documents for this question.)';
  }
  return chunks
    .map((c, i) => `[Source ${i + 1}: ${c.filename}${c.page ? `, page ${c.page}` : ''}]\n${c.content}`)
    .join('\n\n');
}

function buildExternalBlock(web?: WebResult[], youtube?: YoutubeResult[], generalKnowledgeOnly?: boolean): string {
  if (generalKnowledgeOnly) {
    return `\n\n═══ EXTERNAL SOURCES (granted this turn) ═══\nThe student approved using your general knowledge for this question (no web search was run). Answer from general knowledge, but explicitly label it as general knowledge, not from their materials or the web.\n═══ END EXTERNAL SOURCES ═══`;
  }
  if (!web?.length && !youtube?.length) return '';

  const webBlock = web?.length
    ? web.map((r, i) => `[Web ${i + 1}: ${r.title}](${r.url})\n${r.snippet}`).join('\n\n')
    : '(no web results)';
  const ytBlock = youtube?.length
    ? youtube.map((v, i) => `[Video ${i + 1}: ${v.title}](${v.url})`).join('\n')
    : '';

  return `\n\n═══ EXTERNAL SOURCES (granted this turn, student approved external search) ═══\nWEB RESULTS:\n${webBlock}${ytBlock ? `\n\nRELEVANT VIDEOS:\n${ytBlock}` : ''}\n\nCite these clearly as external and never present them as if they came from the student's own materials.\n═══ END EXTERNAL SOURCES ═══`;
}

export function buildSystemPrompt(
  subjectName: string,
  mode: ChatMode,
  knowledgeMode: KnowledgeMode,
  chunks: RetrievedChunk[],
  possibleConflict: boolean,
  external?: { web?: WebResult[]; youtube?: YoutubeResult[]; generalKnowledgeOnly?: boolean },
  weakTopics: { topic: string; strength: number }[] = [],
): string {
  const persona = BASE_PERSONA.replace(/{subject_name}/g, subjectName);
  let modeBlock = MODE_INSTRUCTIONS[mode];
  if (mode === 'practice') modeBlock += '\n' + practiceResultInstruction(subjectName);
  const kmBlock = knowledgeModeInstructions(knowledgeMode);
  const evidenceBlock = evidenceInstructions(knowledgeMode);
  const contextBlock = buildContextBlock(chunks);
  const sourceScores = new Map<string, { score: number; label: string }>();
  chunks.forEach((chunk, i) => {
    const prior = sourceScores.get(chunk.documentId);
    if (!prior || chunk.similarity > prior.score) {
      sourceScores.set(chunk.documentId, {
        score: chunk.similarity,
        label: `[Source ${i + 1}: ${chunk.filename}${chunk.page ? `, page ${chunk.page}` : ''}]`,
      });
    }
  });
  const sourceCandidates = [...sourceScores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((source) => source.label);
  const conflictNote = possibleConflict
    ? `\n\nCROSS-SOURCE CHECK: These sources are similarly relevant, so compare their claims carefully: ${sourceCandidates.join(' and ')}. Similar relevance is only a cue to compare, not proof that the documents conflict. If they make materially contradictory claims, begin by clearly saying "Your materials disagree on this point," list each claim with its exact source label, and explain the disagreement without silently choosing a winner. If the claims are compatible, say so and answer normally.`
    : '';
  const externalBlock = buildExternalBlock(external?.web, external?.youtube, external?.generalKnowledgeOnly);
  const personalization = personalizationBlock(weakTopics);

  return `${persona}\n\n${modeBlock}\n\n${kmBlock}\n${STRICT_RULES}\n${evidenceBlock}${conflictNote}${personalization}\n\n═══ CONTEXT FROM STUDENT'S DOCUMENTS ═══\n${contextBlock}\n═══ END CONTEXT ═══${externalBlock}`;
}

// ── Deterministic "ask permission" follow-up parsing ──────────────────────
export const EXTERNAL_OFFER_PREFIX = "I couldn't find this information in your uploaded study materials";

export function buildExternalOfferMessage(subjectName: string): string {
  return `${EXTERNAL_OFFER_PREFIX} for **${subjectName}**.\n\nWant me to:\n1. **Search the web** for this, or\n2. **Answer from general knowledge** instead (no search)?\n\nJust let me know which.`;
}

export function isAffirmativeReply(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(yes|yeah|yep|sure|ok(ay)?|please|go ahead|do it|1|2|web|search|general|use (the )?web|use general knowledge)\b/.test(t)
    || /\b(search the web|general knowledge)\b/.test(t);
}

export function parseExternalChoice(text: string): 'web' | 'general_knowledge' {
  const t = text.trim().toLowerCase();
  if (/\b(1|web|search)\b/.test(t)) return 'web';
  if (/\b(2|general)\b/.test(t)) return 'general_knowledge';
  return 'web';
}

// Strips the practice-result marker off a message and returns what it
// found, so route.ts can persist it without the student ever seeing the
// raw marker text.
export function extractPracticeResult(answer: string): { cleaned: string; topic: string; correct: boolean } | null {
  const m = answer.match(PRACTICE_RESULT_MARKER_RE);
  if (!m) return null;
  return {
    cleaned: answer.slice(0, m.index).trimEnd(),
    topic: m[1]?.trim() || 'General',
    correct: m[2] === 'true',
  };
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

export async function generateAnswer(params: {
  subjectName: string;
  mode: ChatMode;
  knowledgeMode: KnowledgeMode;
  question: string;
  chunks: RetrievedChunk[];
  history: ChatTurn[];
  hasDocs: boolean;
  external?: { web?: WebResult[]; youtube?: YoutubeResult[]; generalKnowledgeOnly?: boolean };
  weakTopics?: { topic: string; strength: number }[];
}): Promise<{ answer: string; possibleConflict: boolean }> {
  const { subjectName, mode, knowledgeMode, question, chunks, history, hasDocs, external, weakTopics = [] } = params;

  if (!hasDocs) {
    return {
      answer: `Hey! You haven't uploaded any study materials for **${subjectName}** yet, so I can't ground answers in anything of yours right now.\n\nUpload a supported file using the **Files** button and I'll be able to explain concepts, quiz you, and answer questions straight from your own course material.`,
      possibleConflict: false,
    };
  }

  const possibleConflict = (await import('./retrieve')).flagPossibleConflict(chunks);
  const system = buildSystemPrompt(subjectName, mode, knowledgeMode, chunks, possibleConflict, external, weakTopics);

  const messages = [
    { role: 'system' as const, content: system },
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: question },
  ];

  const { text } = await chatComplete({ messages, temperature: 0.4, maxTokens: 1500 });

  return { answer: text, possibleConflict };
}
