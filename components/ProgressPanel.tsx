'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatTimestamp } from '@/lib/format-timestamp';

interface ProgressRow { topic: string; strength: number; attempts: number }
interface SessionRow { id: string; mode: string; score: number | null; total: number | null; completed_at: string | null; topic_breakdown: Record<string, { correct: number; total: number }> | null }

function strengthColor(strength: number) {
  if (strength >= 0.75) return { bar: 'var(--success-text)', bg: 'var(--success-bg)' };
  if (strength >= 0.5) return { bar: '#ca8a04', bg: 'rgba(234,179,8,0.12)' };
  return { bar: 'var(--error-text)', bg: 'var(--error-bg)' };
}

const MODE_ICON: Record<string, string> = {
  quiz: 'fa-clipboard-question', exam: 'fa-user-graduate', practice: 'fa-comments',
};

export default function ProgressPanel({
  subjectId, subjectName, onClose, onPracticeTopic,
}: {
  subjectId: string;
  subjectName: string;
  onClose: () => void;
  onPracticeTopic: (topic: string) => void;
}) {
  const supabase = createClient();
  const [progress, setProgress] = useState<ProgressRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      supabase.from('student_progress').select('topic, strength, attempts')
        .eq('subject_id', subjectId).order('strength', { ascending: true }),
      supabase.from('study_sessions').select('id, mode, score, total, completed_at, topic_breakdown')
        .eq('subject_id', subjectId).order('completed_at', { ascending: false }).limit(10),
    ]).then(([p, s]) => {
      if (cancelled) return;
      if (p.error || s.error) {
        throw new Error(p.error?.message || s.error?.message || 'Progress query failed.');
      }
      setProgress((p.data ?? []) as ProgressRow[]);
      setSessions((s.data ?? []) as SessionRow[]);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setLoading(false);
      setError("Couldn't load your progress — check your connection and try again.");
    });
    return () => { cancelled = true; };
  }, [subjectId]);

  const overall = progress.length
    ? Math.round((progress.reduce((sum, p) => sum + p.strength, 0) / progress.length) * 100)
    : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg rounded-3xl p-7 fade-in flex flex-col" style={{ background: 'var(--bg-modal)', border: '1px solid var(--border-glass)', boxShadow: '0 24px 48px -8px rgba(0,0,0,0.30)', maxHeight: '85vh' }}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Progress</h3>
            <p className="text-xs mt-0.5 font-bold" style={{ color: 'var(--text-muted)' }}>{subjectName}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center btn-ghost">
            <i className="fa-solid fa-xmark text-sm" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12"><div className="t-spinner w-6 h-6" /></div>
        ) : error ? (
          <div className="text-center py-10">
            <i className="fa-solid fa-triangle-exclamation text-2xl mb-3" style={{ color: 'var(--error-text)' }} />
            <p className="text-sm font-bold t-error inline-block px-3 py-2 rounded-xl">{error}</p>
          </div>
        ) : !progress.length && !sessions.length ? (
          <div className="text-center py-10">
            <i className="fa-solid fa-chart-line text-2xl mb-3" style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>No progress yet</p>
            <p className="text-xs mt-1 max-w-xs mx-auto" style={{ color: 'var(--text-muted)' }}>
              Take a quiz, exam, or practice session and this fills in automatically.
            </p>
          </div>
        ) : (
          <div className="overflow-y-auto custom-scrollbar space-y-6">
            {overall !== null && (
              <div className="text-center">
                <p className="text-3xl font-black" style={{ color: 'var(--peak-active-text)' }}>{overall}%</p>
                <p className="text-[0.65rem] font-bold uppercase tracking-wide mt-1" style={{ color: 'var(--text-muted)' }}>Overall mastery, across {progress.length} topic{progress.length !== 1 ? 's' : ''}</p>
              </div>
            )}

            {!!progress.length && (
              <div>
                <p className="text-[0.65rem] font-black uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>By topic</p>
                <div className="space-y-2.5">
                  {progress.map((p) => {
                    const c = strengthColor(p.strength);
                    return (
                      <div key={p.topic}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{p.topic}</span>
                          <span className="text-[0.65rem] font-bold" style={{ color: c.bar }}>{Math.round(p.strength * 100)}%</span>
                        </div>
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: c.bg }}>
                          <div className="h-full rounded-full" style={{ width: `${Math.round(p.strength * 100)}%`, background: c.bar }} />
                        </div>
                        <p className="text-[0.58rem] mt-0.5" style={{ color: 'var(--text-muted)' }}>{p.attempts} attempt{p.attempts !== 1 ? 's' : ''}</p>
                        <button
                          onClick={() => onPracticeTopic(p.topic)}
                          className="text-[0.65rem] font-bold mt-1 transition"
                          style={{ color: 'var(--peak-active-border)' }}
                        >
                          <i className="fa-solid fa-bullseye mr-1" />Practice this topic
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!!sessions.length && (
              <div>
                <p className="text-[0.65rem] font-black uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>Recent sessions</p>
                <div className="space-y-1.5">
                  {sessions.map((s) => (
                    <div key={s.id} className="file-pill justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <i className={`fa-solid ${MODE_ICON[s.mode] || 'fa-circle'} shrink-0`} style={{ color: 'var(--peak-active-border)' }} />
                        <span className="text-xs font-semibold capitalize" style={{ color: 'var(--text-primary)' }}>{s.mode}</span>
                        {s.completed_at && <time dateTime={s.completed_at} title={new Date(s.completed_at).toLocaleString()} className="text-[0.6rem]" style={{ color: 'var(--text-muted)' }}>{formatTimestamp(s.completed_at)}</time>}
                      </div>
                      {s.total != null && (
                        <span className="text-xs font-bold shrink-0" style={{ color: 'var(--text-secondary)' }}>{s.score}/{s.total}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
