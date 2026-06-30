# ══════════════════════════════════════════════════════════════════════════════
# chat.py — Groq LLM integration
# Builds the RAG prompt from retrieved chunks + chat history, calls Groq,
# and returns the answer with source citations.
#
# Persona: "Strict lecturer" tone per the Teachable spec — confident, direct,
# academically rigorous, never hallucinates beyond the provided context.
# ══════════════════════════════════════════════════════════════════════════════

import os
from typing import List, Dict, Any
from groq import Groq

_groq_client = None

def get_groq_client() -> Groq:
    global _groq_client
    if _groq_client is None:
        api_key = os.getenv('GROQ_API_KEY')
        if not api_key:
            raise RuntimeError('GROQ_API_KEY environment variable is not set.')
        _groq_client = Groq(api_key=api_key)
    return _groq_client


GROQ_MODEL = 'llama-3.3-70b-versatile'

# ══════════════════════════════════════════════════════════════════════════════
# System prompt — defines Teachable's personality and strict rules
# ══════════════════════════════════════════════════════════════════════════════
SYSTEM_PROMPT = """You are Teachable, a personal AI tutor for the subject "{subject_name}".

Your personality: You are knowledgeable, direct, and academically rigorous — like a
respected lecturer who genuinely wants students to understand material deeply, not
just get quick answers. You are warm but not soft; you hold students to a high
standard and push them to think, while remaining patient and encouraging.

STRICT RULES — follow these without exception:

1. Answer ONLY using the information in the "CONTEXT FROM STUDENT'S DOCUMENTS" section
   below. This is the student's actual uploaded study material and is your sole
   source of truth.

2. If the context does not contain the answer, say so directly:
   "I couldn't find this information in your uploaded study materials."
   Then ask: "Would you like me to answer using my general knowledge instead?"
   Do NOT silently fall back to general knowledge.

3. Never fabricate citations, page numbers, or content that isn't in the context.

4. When you use information from the context, your answer should reflect exactly
   what the documents say — do not contradict or "correct" the uploaded material.

5. You support natural, conversational follow-ups ("simplify that", "give examples",
   "quiz me on this") by using the conversation history provided.

6. For requests like "create practice questions", "summarize this chapter", or
   "quiz me", generate this content using only concepts and facts found in the
   context — do not invent topics not covered in the documents.

7. Use clear Markdown formatting: headers for structure, bold for key terms,
   numbered lists for steps, bullet points for lists. Keep explanations focused
   and well-organized, not rambling.

8. If the student asks something completely unrelated to {subject_name} or their
   documents (e.g. casual chat), you may respond briefly and naturally, then
   gently redirect to the subject material.
"""

NO_DOCS_MESSAGE = """It looks like you haven't uploaded any study materials for **{subject_name}** yet.

Upload your PDFs using the **Files** button above, and I'll be able to answer questions, explain concepts, generate practice questions, and quiz you — all based on your own course material.

Once you've uploaded something, ask me anything!"""


def build_context_block(chunks: List[Dict[str, Any]]) -> str:
    """Format retrieved chunks into a labeled context block for the prompt."""
    if not chunks:
        return "(No relevant content was found in the student's documents for this question.)"

    blocks = []
    for i, chunk in enumerate(chunks, start=1):
        blocks.append(
            f"[Source {i}: {chunk['filename']}, page {chunk['page']}]\n{chunk['text']}"
        )
    return "\n\n".join(blocks)


def build_messages(
    subject_name: str,
    question: str,
    chunks: List[Dict[str, Any]],
    history: List[Dict[str, str]],
) -> List[Dict[str, str]]:
    """Build the full message array sent to Groq."""
    system = SYSTEM_PROMPT.format(subject_name=subject_name)
    context_block = build_context_block(chunks)

    system_with_context = (
        f"{system}\n\n"
        f"═══ CONTEXT FROM STUDENT'S DOCUMENTS ═══\n{context_block}\n"
        f"═══ END CONTEXT ═══"
    )

    messages = [{'role': 'system', 'content': system_with_context}]

    # Include prior conversation turns for natural follow-ups
    for turn in history:
        role = 'assistant' if turn.get('role') == 'assistant' else 'user'
        messages.append({'role': role, 'content': turn.get('content', '')})

    messages.append({'role': 'user', 'content': question})
    return messages


def generate_answer(
    subject_name: str,
    question: str,
    chunks: List[Dict[str, Any]],
    history: List[Dict[str, str]],
    has_docs: bool,
) -> Dict[str, Any]:
    """
    Full RAG generation step. Returns:
    { 'answer': str, 'sources': [{ 'filename': str, 'page': int }] }
    """
    if not has_docs:
        return {
            'answer':  NO_DOCS_MESSAGE.format(subject_name=subject_name),
            'sources': [],
        }

    client   = get_groq_client()
    messages = build_messages(subject_name, question, chunks, history)

    try:
        completion = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            temperature=0.3,     # lower = more grounded, less creative drift
            max_tokens=1200,
        )
        answer = completion.choices[0].message.content
    except Exception as e:
        raise RuntimeError(f'AI generation failed: {str(e)}')

    # Build unique source list (dedupe by filename + page)
    seen = set()
    sources = []
    for chunk in chunks:
        key = (chunk['filename'], chunk['page'])
        if key not in seen:
            seen.add(key)
            sources.append({'filename': chunk['filename'], 'page': chunk['page']})

    return {'answer': answer, 'sources': sources}
