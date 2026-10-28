'use client';

import { useState, useTransition } from 'react';
import { updateSubjectKnowledgeMode } from '@/app/dashboard/actions';

type KnowledgeMode = 'materials_only' | 'ask_before_external' | 'materials_web';

const OPTIONS: { value: KnowledgeMode | null; label: string; description: string }[] = [
  { value: null, label: 'Account default', description: 'Use whatever your account-wide default is (currently "Ask Before External" unless changed).' },
  { value: 'materials_only', label: 'Course Materials Only', description: 'Never use outside knowledge or search the web, even if your materials don\'t cover something.' },
  { value: 'ask_before_external', label: 'Ask Before External Sources', description: 'Answer from your materials first. If they don\'t cover it, ask before searching the web or using general knowledge.' },
  { value: 'materials_web', label: 'Materials + Web', description: 'Answer from your materials first, and automatically search the web when they don\'t cover something — no need to ask each time.' },
];

export default function SubjectSettingsPanel({
  subjectId, subjectName, currentMode, onClose, onUpdated,
}: {
  subjectId: string;
  subjectName: string;
  currentMode: string | null;
  onClose: () => void;
  onUpdated: (mode: string | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(currentMode);
  const [saving, startTransition] = useTransition();
  const [error, setError] = useState('');

  function save() {
    setError('');
    startTransition(async () => {
      const res = await updateSubjectKnowledgeMode(subjectId, selected);
      if (res.error) { setError(res.error); return; }
      onUpdated(selected);
      onClose();
    });
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-3xl p-7 fade-in" style={{ background: 'var(--bg-modal)', border: '1px solid var(--border-glass)', boxShadow: '0 24px 48px -8px rgba(0,0,0,0.30)' }}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Subject Settings</h3>
            <p className="text-xs mt-0.5 font-bold" style={{ color: 'var(--text-muted)' }}>{subjectName}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center btn-ghost">
            <i className="fa-solid fa-xmark text-sm" />
          </button>
        </div>

        <p className="text-[0.65rem] font-black uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)' }}>Knowledge mode</p>
        <div className="space-y-2 mb-4">
          {OPTIONS.map((opt) => (
            <label key={opt.label} className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer"
              style={{
                background: selected === opt.value ? 'var(--peak-active-bg)' : 'var(--bg-input)',
                border: `1px solid ${selected === opt.value ? 'var(--peak-active-border)' : 'var(--border-glass)'}`,
              }}>
              <input type="radio" name="knowledge_mode" checked={selected === opt.value}
                onChange={() => setSelected(opt.value)} className="t-checkbox mt-0.5" />
              <div>
                <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{opt.label}</p>
                <p className="text-[0.68rem] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{opt.description}</p>
              </div>
            </label>
          ))}
        </div>

        {error && <div className="mb-3 px-3 py-2 rounded-xl text-xs font-semibold t-error">{error}</div>}
        <button onClick={save} disabled={saving} className="w-full py-3 rounded-xl font-bold text-sm btn-primary transition disabled:opacity-50">
          {saving ? <><i className="fa-solid fa-spinner animate-spin mr-2" />Saving…</> : 'Save'}
        </button>
      </div>
    </div>
  );
}
