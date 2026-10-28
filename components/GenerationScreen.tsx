'use client';

// Shared "configure, then generate" screen used by Flashcards and Quiz/Exam
// before a set/assessment exists yet. Was previously duplicated ~25 lines
// at a time between FlashcardDeck.tsx and AssessmentRunner.tsx; extracted
// so a visual tweak only has to be made once, and so Practice mode (likely
// wanting a similar "configure before starting" screen) has this ready.
export default function GenerationScreen({
  icon, title, description, topic, onTopicChange, extraFields, error, generating, onGenerate, buttonLabel,
}: {
  icon: string;
  title: string;
  description: string;
  topic: string;
  onTopicChange: (v: string) => void;
  extraFields?: React.ReactNode;
  error: string;
  generating: boolean;
  onGenerate: () => void;
  buttonLabel: string;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center overflow-y-auto custom-scrollbar">
      <i className={`fa-solid ${icon} text-3xl`} style={{ color: 'var(--peak-active-border)' }} />
      <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      <p className="text-sm max-w-sm" style={{ color: 'var(--text-secondary)' }}>{description}</p>
      <input value={topic} onChange={(e) => onTopicChange(e.target.value)} placeholder="e.g. recursion (optional)"
        className="t-input w-full max-w-xs px-4 py-2.5 rounded-xl text-sm" style={{ outline: 'none' }} />
      {extraFields}
      {error && <div className="px-3 py-2 rounded-xl text-xs font-semibold t-error max-w-sm">{error}</div>}
      <button onClick={onGenerate} disabled={generating} className="px-6 py-3 rounded-full text-sm font-bold btn-primary transition disabled:opacity-50">
        {generating ? <><i className="fa-solid fa-spinner animate-spin mr-2" />Generating…</> : buttonLabel}
      </button>
    </div>
  );
}
