# ══════════════════════════════════════════════════════════════════════════════
# main.py — Teachable FastAPI backend
# Routes: /api/upload  /api/chat  /api/document/{id}  /api/subject/{id}  /health
# ══════════════════════════════════════════════════════════════════════════════

import os
import uuid
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

from auth import get_current_user
from pdf_processor import process_pdf
from embeddings import upsert_chunks, search_chunks, delete_document_vectors, delete_subject_vectors
from chat import generate_answer

# ══════════════════════════════════════════════════════════════════════════════
# App setup
# ══════════════════════════════════════════════════════════════════════════════
app = FastAPI(title='Teachable API', version='1.0.0')

# ── CORS — allow your Firebase Hosting domain(s) ──────────────────────────────
ALLOWED_ORIGINS = os.getenv('ALLOWED_ORIGINS', '*').split(',')

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20MB


# ══════════════════════════════════════════════════════════════════════════════
# Health check — used by Render + for quick manual testing
# ══════════════════════════════════════════════════════════════════════════════
@app.get('/health')
async def health():
    return {'status': 'ok', 'service': 'Teachable API'}


@app.get('/')
async def root():
    return {'message': 'Teachable API is running.'}


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/upload — process and index a PDF
# ══════════════════════════════════════════════════════════════════════════════
@app.post('/api/upload')
async def upload_document(
    file: UploadFile = File(...),
    subject_id: str = Form(...),
    subject_name: str = Form(...),
    user=Depends(get_current_user),
):
    user_id = user['uid']

    # ── Validate file type ────────────────────────────────────────────────────
    if file.content_type != 'application/pdf':
        raise HTTPException(status_code=400, detail='Only PDF files are supported.')

    # ── Read + validate size ──────────────────────────────────────────────────
    file_bytes = await file.read()
    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail='File exceeds the 20MB limit.')
    if len(file_bytes) == 0:
        raise HTTPException(status_code=400, detail='The uploaded file is empty.')

    document_id = str(uuid.uuid4())

    # ── Process: extract → chunk ──────────────────────────────────────────────
    try:
        chunks = process_pdf(
            file_bytes=file_bytes,
            filename=file.filename,
            user_id=user_id,
            subject_id=subject_id,
            document_id=document_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # ── Embed + store in Pinecone ─────────────────────────────────────────────
    try:
        chunk_count = upsert_chunks(chunks)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Failed to index document: {str(e)}')

    return {
        'success':     True,
        'document_id': document_id,
        'filename':    file.filename,
        'chunk_count': chunk_count,
    }


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/chat — ask a question, get a RAG-generated answer
# ══════════════════════════════════════════════════════════════════════════════
class ChatTurn(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    subject_id:   str
    question:     str
    history:      Optional[List[ChatTurn]] = []
    has_docs:     bool = True
    subject_name: Optional[str] = None


@app.post('/api/chat')
async def chat(req: ChatRequest, user=Depends(get_current_user)):
    user_id = user['uid']

    if not req.question.strip():
        raise HTTPException(status_code=400, detail='Question cannot be empty.')

    subject_label = req.subject_name or 'this subject'

    # ── No documents uploaded yet — short-circuit ─────────────────────────────
    if not req.has_docs:
        result = generate_answer(
            subject_name=subject_label,
            question=req.question,
            chunks=[],
            history=[],
            has_docs=False,
        )
        return result

    # ── Retrieve relevant chunks from Pinecone ────────────────────────────────
    try:
        chunks = search_chunks(
            question=req.question,
            user_id=user_id,
            subject_id=req.subject_id,
            top_k=5,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Search failed: {str(e)}')

    # ── Generate answer with Groq ─────────────────────────────────────────────
    try:
        history_dicts = [{'role': t.role, 'content': t.content} for t in req.history]
        result = generate_answer(
            subject_name=subject_label,
            question=req.question,
            chunks=chunks,
            history=history_dicts,
            has_docs=True,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))

    return result


# ══════════════════════════════════════════════════════════════════════════════
# DELETE /api/document/{document_id} — remove a single document's vectors
# Note: subject_id must be passed as a query param since vectors are filtered
# by both subject_id and document_id.
# ══════════════════════════════════════════════════════════════════════════════
@app.delete('/api/document/{document_id}')
async def delete_document(
    document_id: str,
    subject_id: str,
    user=Depends(get_current_user),
):
    user_id = user['uid']
    try:
        delete_document_vectors(user_id=user_id, subject_id=subject_id, document_id=document_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Failed to delete document: {str(e)}')

    return {'success': True}


# ══════════════════════════════════════════════════════════════════════════════
# DELETE /api/subject/{subject_id} — remove all vectors for a subject
# ══════════════════════════════════════════════════════════════════════════════
@app.delete('/api/subject/{subject_id}')
async def delete_subject(subject_id: str, user=Depends(get_current_user)):
    user_id = user['uid']
    try:
        delete_subject_vectors(user_id=user_id, subject_id=subject_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Failed to delete subject: {str(e)}')

    return {'success': True}


if __name__ == '__main__':
    import uvicorn
    port = int(os.getenv('PORT', 8000))
    uvicorn.run(app, host='0.0.0.0', port=port)
