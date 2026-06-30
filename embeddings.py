# ══════════════════════════════════════════════════════════════════════════════
# embeddings.py — Vector generation and Pinecone operations
# Uses sentence-transformers (all-mpnet-base-v2) to generate 768-dim vectors.
# Handles upsert, query, and deletion in Pinecone.
# ══════════════════════════════════════════════════════════════════════════════

import os
from typing import List, Dict, Any
from sentence_transformers import SentenceTransformer
from pinecone import Pinecone

# ── Load model once at startup (cached after first load) ─────────────────────
# all-mpnet-base-v2 produces 768-dimensional vectors — matches your Pinecone index
print('Loading embedding model…')
_model = SentenceTransformer('all-mpnet-base-v2')
print('Embedding model ready.')

# ── Pinecone client ───────────────────────────────────────────────────────────
_pinecone_client = None
_pinecone_index  = None

def get_pinecone_index():
    global _pinecone_client, _pinecone_index
    if _pinecone_index is None:
        api_key    = os.getenv('PINECONE_API_KEY')
        index_name = os.getenv('PINECONE_INDEX_NAME', 'teachable')
        if not api_key:
            raise RuntimeError('PINECONE_API_KEY environment variable is not set.')
        _pinecone_client = Pinecone(api_key=api_key)
        _pinecone_index  = _pinecone_client.Index(index_name)
    return _pinecone_index


# ══════════════════════════════════════════════════════════════════════════════
# Generate embeddings
# ══════════════════════════════════════════════════════════════════════════════
def embed_texts(texts: List[str]) -> List[List[float]]:
    """Generate 768-dim embeddings for a list of strings."""
    vectors = _model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
    return vectors.tolist()


def embed_single(text: str) -> List[float]:
    """Generate a single embedding vector."""
    vector = _model.encode([text], normalize_embeddings=True)
    return vector[0].tolist()


# ══════════════════════════════════════════════════════════════════════════════
# Upsert chunks into Pinecone
# ══════════════════════════════════════════════════════════════════════════════
def upsert_chunks(chunks: List[Dict[str, Any]]) -> int:
    """
    Generate embeddings for all chunks and upsert into Pinecone.
    Returns the number of vectors upserted.
    """
    if not chunks:
        return 0

    index   = get_pinecone_index()
    texts   = [c['text'] for c in chunks]
    vectors = embed_texts(texts)

    # Build Pinecone upsert payload
    upsert_data = []
    for chunk, vector in zip(chunks, vectors):
        upsert_data.append({
            'id':       chunk['id'],
            'values':   vector,
            'metadata': chunk['metadata'],
        })

    # Upsert in batches of 100 (Pinecone limit)
    batch_size = 100
    for i in range(0, len(upsert_data), batch_size):
        batch = upsert_data[i : i + batch_size]
        index.upsert(vectors=batch)

    return len(upsert_data)


# ══════════════════════════════════════════════════════════════════════════════
# Search Pinecone — retrieve relevant chunks for a question
# ══════════════════════════════════════════════════════════════════════════════
def search_chunks(
    question: str,
    user_id: str,
    subject_id: str,
    top_k: int = 5,
) -> List[Dict[str, Any]]:
    """
    Embed the question and search Pinecone for the most relevant chunks.
    Filters strictly by user_id + subject_id for security.

    Returns list of: {
        'text':     str,
        'filename': str,
        'page':     int,
        'score':    float,
    }
    """
    index         = get_pinecone_index()
    query_vector  = embed_single(question)

    results = index.query(
        vector=query_vector,
        top_k=top_k,
        filter={
            'user_id':    {'$eq': user_id},
            'subject_id': {'$eq': subject_id},
        },
        include_metadata=True,
    )

    chunks = []
    for match in results.matches:
        if match.score < 0.3:   # relevance threshold — skip poor matches
            continue
        meta = match.metadata
        chunks.append({
            'text':        meta.get('text', ''),
            'filename':    meta.get('filename', ''),
            'page':        meta.get('page', 0),
            'score':       round(match.score, 3),
        })

    return chunks


# ══════════════════════════════════════════════════════════════════════════════
# Delete vectors — called when user deletes a file or subject
# ══════════════════════════════════════════════════════════════════════════════
def delete_document_vectors(user_id: str, subject_id: str, document_id: str):
    """Delete all Pinecone vectors belonging to a specific document."""
    index = get_pinecone_index()
    index.delete(
        filter={
            'user_id':     {'$eq': user_id},
            'subject_id':  {'$eq': subject_id},
            'document_id': {'$eq': document_id},
        }
    )


def delete_subject_vectors(user_id: str, subject_id: str):
    """Delete all Pinecone vectors belonging to a specific subject."""
    index = get_pinecone_index()
    index.delete(
        filter={
            'user_id':    {'$eq': user_id},
            'subject_id': {'$eq': subject_id},
        }
    )
