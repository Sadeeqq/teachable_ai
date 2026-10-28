'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import GenerationScreen from './GenerationScreen';
import { formatDocumentCitation } from '@/lib/rag/citations';
import { formatTimestamp } from '@/lib/format-timestamp';

interface Card { id: string; front: string; back: string; citation: { filename: string; page: number | null; section?: string | null } }
interface FlashcardSet { id: string; title: string; cards: Card[]; created_at?: string }

export default function FlashcardDeck({ chatId, subjectId }: { chatId: string; subjectId: string }) {
  const supabase = createClient();
  const [set, setSet] = useState<FlashcardSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [topic, setTopic] = useState('');
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    setLoading(true);
    setIndex(0);
    setFlipped(false);
    setError('');
    void (async () => {
      try {
        const { data, error } = await supabase.from('flashcard_sets').select('*').eq('chat_id', chatId)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        setSet(data as FlashcardSet | null);
        setLoading(false);
      } catch {
        // Without this, a network hiccup here leaves the spinner running
        // forever with no feedback — better to land on the generation
        // screen with a clear error than spin indefinitely.
        setSet(null);
        setLoading(false);
        setError("Couldn't load your flashcards — check your connection and try again.");
      }
    })();
  }, [chatId]);

  async function generate() {
    setGenerating(true);
    setError('');
    try {
      const res = await fetch('/api/generate/flashcards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, subject_id: subjectId, topic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      setSet(data.set);
      setIndex(0); setFlipped(false);
    } catch (err: any) {
      setError(err.message || 'Failed to generate flashcards.');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><div className="t-spinner w-6 h-6" /></div>;
  }

  if (!set) {
    return (
      <GenerationScreen
        icon="fa-layer-group"
        title="Generate a flashcard deck"
        description="Optionally name a topic, or leave blank to cover the whole document."
        topic={topic}
        onTopicChange={setTopic}
        error={error}
        generating={generating}
        onGenerate={generate}
        buttonLabel="Generate Flashcards"
      />
    );
  }

  const card = set.cards[index];

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 p-6">
      <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {set.title} · {index + 1} / {set.cards.length}
      </p>
      {set.created_at && <time dateTime={set.created_at} title={new Date(set.created_at).toLocaleString()} className="-mt-4 text-[0.6rem]" style={{ color: 'var(--text-muted)' }}>Generated {formatTimestamp(set.created_at)}</time>}

      <div onClick={() => setFlipped((f) => !f)} className="w-full max-w-lg cursor-pointer select-none"
        style={{ perspective: '1000px' }}>
        <div className="rounded-3xl p-8 min-h-[220px] flex flex-col items-center justify-center text-center transition-all"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-glass)', boxShadow: '0 12px 32px -8px rgba(0,0,0,0.15)' }}>
          <p className="text-[0.6rem] font-black uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)' }}>
            {flipped ? 'Answer' : 'Question'}
          </p>
          <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            {flipped ? card.back : card.front}
          </p>
          {flipped && (
            <p className="text-[0.65rem] mt-4" style={{ color: 'var(--text-muted)' }}>
              {formatDocumentCitation(card.citation)}
            </p>
          )}
        </div>
      </div>
      <p className="text-[0.65rem]" style={{ color: 'var(--text-muted)' }}>Click the card to flip</p>

      <div className="flex items-center gap-3">
        <button onClick={() => { setIndex((i) => Math.max(0, i - 1)); setFlipped(false); }} disabled={index === 0}
          className="w-10 h-10 rounded-full flex items-center justify-center btn-ghost disabled:opacity-30">
          <i className="fa-solid fa-chevron-left text-sm" />
        </button>
        <button onClick={() => { setIndex((i) => Math.min(set.cards.length - 1, i + 1)); setFlipped(false); }} disabled={index === set.cards.length - 1}
          className="w-10 h-10 rounded-full flex items-center justify-center btn-ghost disabled:opacity-30">
          <i className="fa-solid fa-chevron-right text-sm" />
        </button>
      </div>

      <button onClick={() => setSet(null)} className="text-[0.65rem] font-bold underline" style={{ color: 'var(--text-muted)' }}>
        Generate a new deck
      </button>
    </div>
  );
}
