import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildExternalOfferMessage,
  EXTERNAL_OFFER_PREFIX,
  NEED_EXTERNAL_MARKER,
  generateAnswer,
  isAffirmativeReply,
  parseExternalChoice,
  type ChatMode,
  type ChatTurn,
  type KnowledgeMode,
} from './chat';
import type { RetrievedChunk } from './retrieve';
import { groqExternalSearch, type WebResult, type YoutubeResult } from './external';
import { tryConsumeLimit } from './rateLimit';

export interface ChatCitation {
  kind: 'web' | 'youtube';
  title: string;
  url: string;
  channel?: string;
  timestamp_s?: number | null;
}

interface ExternalSources {
  web: WebResult[];
  youtube: YoutubeResult[];
}

async function searchExternalSources(
  supabase: SupabaseClient,
  userId: string,
  question: string,
): Promise<{ allowed: boolean; sources: ExternalSources }> {
  const { allowed } = await tryConsumeLimit(supabase, userId, 'external_search');
  if (!allowed) return { allowed: false, sources: { web: [], youtube: [] } };

  try {
    return { allowed: true, sources: await groqExternalSearch(question, 6) };
  } catch {
    return { allowed: true, sources: { web: [], youtube: [] } };
  }
}

function buildExternalCitations({ web, youtube }: ExternalSources): ChatCitation[] {
  return [
    ...web.map((result) => ({ kind: 'web' as const, title: result.title, url: result.url })),
    ...youtube.map((result) => ({
      kind: 'youtube' as const,
      title: result.title,
      url: result.url,
      channel: result.channel,
      timestamp_s: result.timestamp_s,
    })),
  ];
}

export async function resolveChatAnswer({
  supabase,
  userId,
  subjectName,
  mode,
  knowledgeMode,
  question,
  history,
  chunks,
  hasDocs,
  weakTopics,
}: {
  supabase: SupabaseClient;
  userId: string;
  subjectName: string;
  mode: ChatMode;
  knowledgeMode: KnowledgeMode;
  question: string;
  history: ChatTurn[];
  chunks: RetrievedChunk[];
  hasDocs: boolean;
  weakTopics: { topic: string; strength: number; attempts: number }[];
}): Promise<{
  answer: string;
  sourceType: string;
  externalCitations: ChatCitation[];
}> {
  const canUseExternal = hasDocs && (mode === 'tutor' || mode === 'practice') && knowledgeMode !== 'materials_only';
  let effectiveQuestion = question;
  let sourceType = hasDocs ? 'material' : 'none';
  let externalCitations: ChatCitation[] = [];
  let fallbackNote = '';
  let answer: string;

  const lastAssistant = [...history].reverse().find((turn) => turn.role === 'assistant');
  const isFollowUp = canUseExternal && knowledgeMode === 'ask_before_external' &&
    !!(lastAssistant?.content.startsWith(EXTERNAL_OFFER_PREFIX) && isAffirmativeReply(question));

  if (isFollowUp) {
    const offerIndexFromEnd = [...history].reverse().findIndex(
      (turn) => turn.role === 'assistant' && turn.content.startsWith(EXTERNAL_OFFER_PREFIX),
    );
    const offerIndex = history.length - 1 - offerIndexFromEnd;
    effectiveQuestion = history[offerIndex - 1]?.content ?? question;

    const choice = parseExternalChoice(question);
    let external: { web?: WebResult[]; youtube?: YoutubeResult[]; generalKnowledgeOnly?: boolean };
    if (choice === 'general_knowledge') {
      external = { generalKnowledgeOnly: true };
      sourceType = 'general_knowledge';
    } else {
      const search = await searchExternalSources(supabase, userId, effectiveQuestion);
      if (!search.allowed) {
        external = { generalKnowledgeOnly: true };
        sourceType = 'general_knowledge';
        fallbackNote = "_(You've reached today's web search limit, so I'm answering from general knowledge instead.)_\n\n";
      } else if (!search.sources.web.length && !search.sources.youtube.length) {
        external = { generalKnowledgeOnly: true };
        sourceType = 'general_knowledge';
        fallbackNote = "_(Web search didn't turn up anything useful, so I'm answering from general knowledge instead.)_\n\n";
      } else {
        external = search.sources;
        sourceType = 'external_web';
        externalCitations = buildExternalCitations(search.sources);
      }
    }

    const generated = await generateAnswer({
      subjectName, mode, knowledgeMode, question: effectiveQuestion, chunks, history, hasDocs, external, weakTopics,
    });
    answer = fallbackNote + generated.answer;
    return { answer, sourceType, externalCitations };
  }

  const initial = await generateAnswer({
    subjectName, mode, knowledgeMode, question: effectiveQuestion, chunks, history, hasDocs, weakTopics,
  });
  const triggered = canUseExternal && initial.answer.trim().startsWith(NEED_EXTERNAL_MARKER);
  if (!triggered) return { answer: initial.answer, sourceType, externalCitations };

  if (knowledgeMode === 'ask_before_external') {
    return {
      answer: buildExternalOfferMessage(subjectName),
      sourceType: 'none',
      externalCitations,
    };
  }

  const search = await searchExternalSources(supabase, userId, effectiveQuestion);
  if (!search.allowed) {
    return {
      answer: `I don't see this covered in your uploaded materials for **${subjectName}**, and you've hit today's web search limit — try again tomorrow, or ask me something else about your materials.`,
      sourceType: 'none',
      externalCitations,
    };
  }
  if (!search.sources.web.length && !search.sources.youtube.length) {
    return {
      answer: `I don't see this covered in your uploaded materials for **${subjectName}**, and a web search didn't turn up anything useful either.`,
      sourceType: 'none',
      externalCitations,
    };
  }

  externalCitations = buildExternalCitations(search.sources);
  const generated = await generateAnswer({
    subjectName,
    mode,
    knowledgeMode,
    question: effectiveQuestion,
    chunks,
    history,
    hasDocs,
    external: search.sources,
    weakTopics,
  });
  return { answer: generated.answer, sourceType: 'external_web', externalCitations };
}
