// POST /api/upload — initialize a direct-to-Storage upload or process an
// already-uploaded object. Keeping file bytes out of this request avoids
// Vercel's 4.5MB Function request-body limit.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { chunkPages } from '@/lib/rag/chunk';
import { extractTextFromSource, getSourceExtension, getSourceMimeType, SUPPORTED_SOURCE_TYPES, validateSourceFile } from '@/lib/rag/source-extract';
import { embedTexts } from '@/lib/rag/embeddings';
import { tryConsumeLimit, limitExceededMessage, RateLimitUnavailableError } from '@/lib/rag/rateLimit';
import { apiAuthFailure, getApiUser } from '@/lib/supabase/api-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_FILE_SIZE = 20 * 1024 * 1024;

export async function POST(request: Request) {
  const supabase = createClient();
  const { user, error: authError } = await getApiUser(supabase);
  if (!user) return apiAuthFailure(authError);

  let body: { action?: string; subject_id?: string; filename?: string; size?: number; document_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'Expected a JSON upload request.' }, { status: 400 });
  }

  if (body.action === 'initialize') {
    const subjectId = body.subject_id;
    const filename = body.filename;
    const size = body.size;
    if (!subjectId || !filename || !Number.isSafeInteger(size) || !size || size < 1) {
      return NextResponse.json({ detail: 'subject_id, filename, and a valid file size are required.' }, { status: 400 });
    }
    if (size > MAX_FILE_SIZE) return NextResponse.json({ detail: 'File exceeds the 20MB limit.' }, { status: 400 });

    const extension = getSourceExtension(filename);
    if (!SUPPORTED_SOURCE_TYPES.includes(extension as (typeof SUPPORTED_SOURCE_TYPES)[number])) {
      return NextResponse.json({ detail: 'Unsupported file type. Upload PDF, DOCX, TXT, Markdown, CSV, JPG, PNG, or WebP.' }, { status: 400 });
    }

    try {
      const uploadLimit = await tryConsumeLimit(supabase, user.id, 'upload');
      if (!uploadLimit.allowed) return NextResponse.json({ detail: limitExceededMessage('upload') }, { status: 429 });
    } catch (error) {
      if (error instanceof RateLimitUnavailableError) return NextResponse.json({ detail: error.message }, { status: 503 });
      throw error;
    }

    const { data: subject, error: subjectErr } = await supabase.from('subjects')
      .select('id').eq('id', subjectId).eq('user_id', user.id).maybeSingle();
    if (subjectErr) {
      console.error('[upload] Subject ownership lookup failed:', subjectErr);
      return NextResponse.json({ detail: 'Could not verify subject access. Please try again.' }, { status: 500 });
    }
    if (!subject) return NextResponse.json({ detail: 'Subject not found.' }, { status: 404 });

    const { data: doc, error: docErr } = await supabase.from('documents')
      .insert({ subject_id: subjectId, user_id: user.id, filename, storage_path: '', status: 'pending' })
      .select('id').single();
    if (docErr || !doc) return NextResponse.json({ detail: `Failed to create document record: ${docErr?.message}` }, { status: 500 });

    const storagePath = `${user.id}/${subjectId}/${doc.id}${extension}`;
    const { error: updateErr } = await supabase.from('documents')
      .update({ storage_path: storagePath }).eq('id', doc.id).eq('user_id', user.id);
    if (updateErr) {
      await supabase.from('documents').delete().eq('id', doc.id).eq('user_id', user.id);
      return NextResponse.json({ detail: 'Could not prepare the file record.' }, { status: 500 });
    }

    return NextResponse.json({ document_id: doc.id, storage_path: storagePath, content_type: getSourceMimeType(extension) });
  }

  if (body.action !== 'process' || !body.document_id) {
    return NextResponse.json({ detail: 'Provide action "initialize" or "process" with its required fields.' }, { status: 400 });
  }

  const { data: doc, error: docErr } = await supabase.from('documents')
    .select('id, subject_id, filename, storage_path, status')
    .eq('id', body.document_id).eq('user_id', user.id).maybeSingle();
  if (docErr || !doc) return NextResponse.json({ detail: 'Document not found.' }, { status: 404 });
  if (!doc.storage_path || doc.status !== 'pending') {
    return NextResponse.json({ detail: 'Document is not ready to be processed.' }, { status: 409 });
  }

  const extension = getSourceExtension(doc.filename);
  const { data: storedFile, error: storageErr } = await supabase.storage.from('documents').download(doc.storage_path);
  if (storageErr || !storedFile) {
    console.error('[upload] Storage download failed:', storageErr);
    await supabase.from('documents').update({ status: 'failed', error_message: 'Could not read the uploaded file from storage.' })
      .eq('id', doc.id).eq('user_id', user.id);
    return NextResponse.json({ detail: 'Could not read the uploaded file from storage.' }, { status: 422 });
  }
  if (storedFile.size > MAX_FILE_SIZE) {
    await supabase.from('documents').update({ status: 'failed', error_message: 'File exceeds the 20MB limit.' })
      .eq('id', doc.id).eq('user_id', user.id);
    return NextResponse.json({ detail: 'File exceeds the 20MB limit.' }, { status: 400 });
  }
  const buffer = Buffer.from(await storedFile.arrayBuffer());
  const validationError = validateSourceFile(extension, buffer);
  if (validationError) {
    await supabase.from('documents').update({ status: 'failed', error_message: validationError })
      .eq('id', doc.id).eq('user_id', user.id);
    return NextResponse.json({ detail: validationError }, { status: 400 });
  }

  const { error: processingErr } = await supabase.from('documents')
    .update({ status: 'processing' }).eq('id', doc.id).eq('user_id', user.id);
  if (processingErr) return NextResponse.json({ detail: 'Could not start document processing.' }, { status: 500 });

  try {
    const pages = await extractTextFromSource(buffer, extension);
    const chunks = chunkPages(pages);
    if (!chunks.length) throw new Error(`Could not extract enough text from this ${extension.slice(1).toUpperCase()} file to index it.`);

    const vectors = await embedTexts(chunks.map((chunk) => chunk.text));
    const rows = chunks.map((chunk, index) => ({
      document_id: doc.id,
      subject_id: doc.subject_id,
      user_id: user.id,
      chunk_index: chunk.chunkIndex,
      page: chunk.page,
      section: chunk.section,
      content: chunk.text,
      embedding: vectors[index],
    }));

    const BATCH = 100;
    for (let index = 0; index < rows.length; index += BATCH) {
      const { error: insertErr } = await supabase.from('document_chunks').insert(rows.slice(index, index + BATCH));
      if (insertErr) throw new Error(`Failed to store chunks: ${insertErr.message}`);
    }

    const { data: readyDoc, error: readyErr } = await supabase.from('documents')
      .update({ status: 'ready', page_count: pages.every((page) => page.page !== null) ? pages.length : null })
      .eq('id', doc.id).eq('user_id', user.id).select('id').single();
    if (readyErr || !readyDoc) throw new Error(`Couldn't mark document as ready: ${readyErr?.message || 'document row was not updated'}`);

    return NextResponse.json({ success: true, document_id: doc.id, filename: doc.filename, chunk_count: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to process document.';
    console.error(`[upload] Failed to process "${doc.filename}":`, err);
    const { error: failedErr } = await supabase.from('documents')
      .update({ status: 'failed', error_message: message }).eq('id', doc.id).eq('user_id', user.id);
    if (failedErr) console.error(`[upload] Couldn't mark "${doc.filename}" as failed:`, failedErr);
    return NextResponse.json({ detail: message }, { status: 422 });
  }
}
