# ══════════════════════════════════════════════════════════════════════════════
# pdf_processor.py — PDF text extraction and chunking
# Extracts text page by page, then splits into overlapping chunks.
# Each chunk keeps metadata: filename, page number, chunk index.
# ══════════════════════════════════════════════════════════════════════════════

import re
from typing import List, Dict, Any
from PyPDF2 import PdfReader
from io import BytesIO

# ── Chunking configuration ────────────────────────────────────────────────────
CHUNK_SIZE    = 500    # target tokens per chunk (approx 4 chars per token)
CHUNK_OVERLAP = 50     # overlap tokens between chunks to preserve context
CHARS_PER_TOKEN = 4    # rough approximation


def extract_text_from_pdf(file_bytes: bytes) -> List[Dict[str, Any]]:
    """
    Extract text from a PDF file.
    Returns a list of pages: [{ 'page': int, 'text': str }]
    """
    pages = []
    try:
        reader = PdfReader(BytesIO(file_bytes))
        for page_num, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ''
            text = clean_text(text)
            if text.strip():
                pages.append({
                    'page': page_num,
                    'text': text,
                })
    except Exception as e:
        raise ValueError(f'Failed to read PDF: {str(e)}')

    if not pages:
        raise ValueError('No readable text found in this PDF. It may be scanned or image-based.')

    return pages


def clean_text(text: str) -> str:
    """Remove excessive whitespace and normalize text."""
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'[^\x20-\x7E\n]', '', text)  # keep printable ASCII
    return text.strip()


def chunk_pages(
    pages: List[Dict[str, Any]],
    filename: str,
    user_id: str,
    subject_id: str,
    document_id: str,
) -> List[Dict[str, Any]]:
    """
    Split pages into overlapping chunks.
    Returns a list of chunks, each with full metadata for Pinecone.

    Each chunk: {
        'id':         str  — unique vector ID for Pinecone,
        'text':       str  — the chunk text,
        'metadata':   dict — stored in Pinecone alongside the vector,
    }
    """
    chunk_chars    = CHUNK_SIZE * CHARS_PER_TOKEN
    overlap_chars  = CHUNK_OVERLAP * CHARS_PER_TOKEN
    chunks         = []
    chunk_index    = 0

    for page_data in pages:
        page_num = page_data['page']
        text     = page_data['text']

        # Slide a window across the page text
        start = 0
        while start < len(text):
            end        = min(start + chunk_chars, len(text))
            chunk_text = text[start:end].strip()

            if len(chunk_text) > 50:  # skip tiny fragments
                vector_id = f"{user_id}_{subject_id}_{document_id}_{chunk_index}"
                chunks.append({
                    'id':   vector_id,
                    'text': chunk_text,
                    'metadata': {
                        'user_id':     user_id,
                        'subject_id':  subject_id,
                        'document_id': document_id,
                        'filename':    filename,
                        'page':        page_num,
                        'chunk_index': chunk_index,
                        'text':        chunk_text,  # stored for retrieval
                    },
                })
                chunk_index += 1

            # Move forward with overlap
            if end == len(text):
                break
            start = end - overlap_chars

    return chunks


def process_pdf(
    file_bytes: bytes,
    filename: str,
    user_id: str,
    subject_id: str,
    document_id: str,
) -> List[Dict[str, Any]]:
    """
    Full pipeline: extract → chunk.
    Returns list of chunks ready for embedding + Pinecone upsert.
    """
    pages  = extract_text_from_pdf(file_bytes)
    chunks = chunk_pages(pages, filename, user_id, subject_id, document_id)

    if not chunks:
        raise ValueError('Could not extract enough text from this PDF to index it.')

    return chunks
