// ═══════════════════════════════════════════════════════════════════════════
// llm.ts — unified chat-completion call with an automatic fallback provider.
//
// Groq is the primary provider per the PRD's chosen stack. But this project
// has already hit two separate Groq-specific failures mid-build (a model
// getting moved to Enterprise-only tier, and response_format not being
// supported on every model) — so rather than hard-coding a single point of
// failure into every call site, every LLM call in the app now goes through
// this one function, which tries Groq (with its own same-provider retry for
// the "param unsupported" case), and only falls back to OpenAI if Groq
// fails outright. If OPENAI_API_KEY isn't set, the fallback is simply
// skipped — this is additive, not a requirement.
//
// Deliberately NOT used for external.ts's groqExternalSearch(): that relies
// on Groq's compound system's built-in web search tool specifically, which
// has no OpenAI equivalent to fall back to — that path already has its own
// graceful degradation (falls back to general-knowledge mode) elsewhere.
// ═══════════════════════════════════════════════════════════════════════════

import { getGroqClient, GROQ_MODEL } from './groq';
import OpenAI from 'openai';

let openaiClient: OpenAI | null | undefined; // undefined = not checked yet, null = checked, not configured

function getOpenAIClient(): OpenAI | null {
  if (openaiClient !== undefined) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  openaiClient = apiKey ? new OpenAI({ apiKey }) : null;
  return openaiClient;
}

const OPENAI_FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini';

export interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export async function chatComplete(params: {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<{ text: string; provider: 'groq' | 'openai' }> {
  const { messages, temperature = 0.4, maxTokens = 1500, jsonMode } = params;
  const jsonParam = jsonMode ? { response_format: { type: 'json_object' as const } } : {};

  // ── 1. Groq, with JSON mode if requested ─────────────────────────────
  try {
    const client = getGroqClient();
    const completion = await client.chat.completions.create({
      model: GROQ_MODEL, messages: messages as any, temperature, max_tokens: maxTokens, ...jsonParam,
    });
    const text = completion.choices[0]?.message?.content;
    if (text) return { text, provider: 'groq' };
  } catch (err: any) {
    console.error('[llm] Groq call failed:', err.message);
  }

  // ── 2. Groq again without JSON mode — covers "param unsupported on this
  //      model" failures specifically, before giving up on Groq entirely ──
  if (jsonMode) {
    try {
      const client = getGroqClient();
      const completion = await client.chat.completions.create({
        model: GROQ_MODEL, messages: messages as any, temperature, max_tokens: maxTokens,
      });
      const text = completion.choices[0]?.message?.content;
      if (text) return { text, provider: 'groq' };
    } catch (err: any) {
      console.error('[llm] Groq retry (no json mode) also failed:', err.message);
    }
  }

  // ── 3. OpenAI fallback, only if configured ───────────────────────────
  const openai = getOpenAIClient();
  if (openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: OPENAI_FALLBACK_MODEL, messages: messages as any, temperature, max_tokens: maxTokens, ...jsonParam,
      });
      const text = completion.choices[0]?.message?.content;
      if (text) return { text, provider: 'openai' };
    } catch (err: any) {
      console.error('[llm] OpenAI fallback failed:', err.message);
    }
  }

  throw new Error(openai
    ? 'Both Groq and the OpenAI fallback failed to generate a response. Check the server logs for the specific errors.'
    : 'Groq failed to generate a response, and no fallback is configured. Set OPENAI_API_KEY to enable one.');
}
