// ═══════════════════════════════════════════════════════════════════════════
// retrieve.ts — subject-scoped vector search against pgvector via the
// match_document_chunks RPC (see supabase/schema.sql). Port of embeddings.py
// search_chunks(), now backed by Postgres instead of Pinecone.
// ═══════════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js';
import { embedSingle } from './embeddings';

export interface RetrievedChunk {
  documentId: string;
  filename: string;
  page: number | null;
  section: string | null;
  content: string;
  similarity: number;
}

export async function searchChunks(
  supabase: SupabaseClient,
  question: string,
  subjectId: string,
  userId: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedSingle(question);

  const { data, error } = await supabase.rpc('match_document_chunks', {
    query_embedding: queryEmbedding,
    match_subject_id: subjectId,
    match_user_id: userId,
    match_count: topK,
    match_threshold: 0.3,
  });

  if (error) throw new Error(`Vector search failed: ${error.message}`);

  return (data ?? []).map((row: any) => ({
    documentId: row.document_id,
    filename: row.filename,
    page: row.page,
    section: row.section,
    content: row.content,
    similarity: row.similarity,
  }));
}

// ── Broad sample retrieval (for Summary / Flashcards / Quiz / Exam) ──────
// These modes generate content FROM the document, not in response to a
// question ABOUT it — so similarity-matching against the literal request
// ("i want flashcards") returns nothing useful. Instead, pull chunks spread
// evenly across every ready document so the model has representative
// coverage of the whole thing to work from.
export async function broadSample(
  supabase: SupabaseClient,
  subjectId: string,
  userId: string,
  maxChunks = 20,
): Promise<RetrievedChunk[]> {
  const { data, error } = await supabase.rpc('sample_document_chunks', {
    p_subject_id: subjectId,
    p_user_id: userId,
    p_max_chunks: maxChunks,
  });

  if (error) throw new Error(`Broad sample failed: ${error.message}`);
  return ((data ?? []) as any[]).map((row) => ({
    documentId: row.document_id,
    filename: row.filename ?? 'Unknown',
    page: row.page,
    section: row.section,
    content: row.content,
    similarity: 1, // not similarity-ranked — this is a representative sample
  }));
}

// Content-generation requests share the same retrieval strategy: use a topic
// search when one was supplied, then fall back to broad document coverage if
// the semantic search returns too little material.
export async function retrieveGenerationChunks(
  supabase: SupabaseClient,
  subjectId: string,
  userId: string,
  topic?: string | null,
): Promise<RetrievedChunk[]> {
  let chunks = topic?.trim()
    ? await searchChunks(supabase, topic.trim(), subjectId, userId, 12)
    : [];
  if (chunks.length < 3) chunks = await broadSample(supabase, subjectId, userId, 20);
  return chunks;
}

// ── Conflict detection (PRD §5.8) ────────────────────────────────────────
// Heuristic pre-check: compare each document's strongest retrieved chunk.
// Similar scores only identify sources worth checking; they do not prove
// the claims conflict. The prompt asks the model to make that distinction.
export function flagPossibleConflict(chunks: RetrievedChunk[]): boolean {
  const strongestByDocument = new Map<string, number>();
  for (const chunk of chunks) {
    strongestByDocument.set(
      chunk.documentId,
      Math.max(strongestByDocument.get(chunk.documentId) ?? -Infinity, chunk.similarity),
    );
  }
  const strongest = [...strongestByDocument.values()].sort((a, b) => b - a);
  if (strongest.length < 2 || strongest[1] < 0.4) return false;
  return strongest[0] - strongest[1] <= 0.08;
}
