'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import GenerationScreen from './GenerationScreen';
import { formatDocumentCitation } from '@/lib/rag/citations';
import { formatTimestamp } from '@/lib/format-timestamp';

interface Question {
  id: string; type: 'multiple_choice' | 'short_answer'; prompt: string;
  options?: string[]; correct_answer: string; explanation: string; topic: string;
  citation: { filename: string; page: number | null; section?: string | null };
}
interface Assessment { id: string; title: string; mode: 'quiz' | 'exam'; questions: Question[]; time_limit_seconds: number | null; created_at?: string }
interface Result { question_id: string; correct: boolean; feedback: string; prompt: string; correct_answer: string; given_answer: string; citation: any }

const QUESTION_COUNT_OPTIONS = [5, 8, 10, 15, 20];

export default function AssessmentRunner({
  chatId, subjectId, mode, onAskTutor,
}: { chatId: string; subjectId: string; mode: 'quiz' | 'exam'; onAskTutor: (prompt: string) => void }) {
  const supabase = createClient();
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [topic, setTopic] = useState('');
  const [questionCount, setQuestionCount] = useState(8);
  const [timed, setTimed] = useState(mode === 'exam');
  const [timerMinutes, setTimerMinutes] = useState(12); // default ≈ 1.5 min/question at 8 questions
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<{ score: number; total: number; results: Result[]; completed_at?: string; progress_warning?: boolean } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setLoading(true);
    setResults(null);
    setAnswers({});
    setSecondsLeft(null);
    setError('');
    void (async () => {
      try {
        const { data, error } = await supabase.from('assessments').select('*').eq('chat_id', chatId)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        if (data && (!Array.isArray(data.questions) || data.questions.length === 0)) {
          throw new Error('This assessment has no questions. Generate a new one to continue.');
        }
        setAssessment(data as Assessment | null);
        let completed = false;
        if (data) {
          const { data: session, error: sessionError } = await supabase
            .from('study_sessions')
            .select('score, total, answers, completed_at')
            .eq('assessment_id', data.id)
            .not('completed_at', 'is', null)
            .order('completed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (sessionError) throw sessionError;
          if (session) {
            completed = true;
            const saved = (session.answers ?? []) as Partial<Result>[];
            const savedByQuestion = new Map(saved.map((result) => [result.question_id, result]));
            setResults({
              score: Number(session.score ?? 0),
              total: Number(session.total ?? data.questions.length),
              completed_at: session.completed_at ?? undefined,
              results: (data.questions as Question[]).map((question) => {
                const result = savedByQuestion.get(question.id);
                return {
                  question_id: question.id,
                  correct: !!result?.correct,
                  feedback: result?.feedback ?? question.explanation,
                  prompt: result?.prompt ?? question.prompt,
                  correct_answer: result?.correct_answer ?? question.correct_answer,
                  given_answer: result?.given_answer ?? '',
                  citation: result?.citation ?? question.citation,
                };
              }),
            });
          }
        }
        setLoading(false);
        if (data?.time_limit_seconds && !completed) setSecondsLeft(data.time_limit_seconds);
      } catch (err) {
        setAssessment(null);
        setLoading(false);
        setError(err instanceof Error && err.message.startsWith('This assessment')
          ? err.message
          : `Couldn't load this ${mode} — check your connection and try again.`);
      }
    })();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [chatId, mode]);

  useEffect(() => {
    if (!assessment || results || secondsLeft === null) return;
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s === null) return null;
        if (s <= 1) { clearInterval(timerRef.current!); submit(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessment, results]);

  async function generate() {
    setGenerating(true);
    setError('');
    try {
      const res = await fetch('/api/generate/assessment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, subject_id: subjectId, mode, topic,
          question_count: questionCount,
          timed,
          time_limit_minutes: (mode === 'exam' || timed) ? timerMinutes : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      setResults(null);   // clear the PREVIOUS attempt's results — without this,
      setAnswers({});     // the new quiz renders straight into the old scored screen
      setAssessment(data.assessment);
      setSecondsLeft(data.assessment.time_limit_seconds);
    } catch (err: any) {
      setError(err.message || 'Failed to generate assessment.');
    } finally {
      setGenerating(false);
    }
  }

  function startNewAssessment() {
    setResults(null);
    setAssessment(null);
    void generate();
  }

  async function submit() {
    if (!assessment || submitting) return;
    setSubmitting(true);
    setError('');
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      const res = await fetch('/api/assessment/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assessment_id: assessment.id,
          answers: assessment.questions.map((q) => ({ question_id: q.id, given_answer: answers[q.id] ?? '' })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      setResults(data);
    } catch (err: any) {
      setError(err.message || 'Failed to submit.');
    } finally {
      setSubmitting(false);
    }
  }

  function askTutorAbout(r: Result) {
    onAskTutor(
      `Can you walk me through this ${mode} question in more depth?\n\n"${r.prompt}"\n\nThe correct answer was "${r.correct_answer}", and I answered "${r.given_answer || '(left it blank)'}". Can you explain the reasoning?`
    );
  }

  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><div className="t-spinner w-6 h-6" /></div>;
  }

  // ── Generation screen ─────────────────────────────────────────────────
  if (!assessment) {
    return (
      <GenerationScreen
        icon={mode === 'exam' ? 'fa-user-graduate' : 'fa-clipboard-question'}
        title={`Generate a ${mode}`}
        description={mode === 'exam' ? 'Timed, no hints or answers shown until you submit.' : 'Optional timer. Explanations shown after you submit.'}
        topic={topic}
        onTopicChange={setTopic}
        error={error}
        generating={generating}
        onGenerate={generate}
        buttonLabel={`Generate ${mode === 'exam' ? 'Exam' : 'Quiz'}`}
        extraFields={
          <>
            <div className="w-full max-w-xs">
              <label className="block text-[0.62rem] font-black uppercase tracking-wider mb-1.5 text-left" style={{ color: 'var(--text-secondary)' }}>
                Number of questions
              </label>
              <div className="flex flex-wrap gap-1.5">
                {QUESTION_COUNT_OPTIONS.map((n) => (
                  <button key={n} onClick={() => setQuestionCount(n)}
                    className="px-3 py-1.5 rounded-full text-xs font-bold transition"
                    style={{
                      background: questionCount === n ? 'var(--peak-active-bg)' : 'var(--bg-card)',
                      border: `1px solid ${questionCount === n ? 'var(--peak-active-border)' : 'var(--border-glass)'}`,
                      color: questionCount === n ? 'var(--peak-active-text)' : 'var(--text-secondary)',
                    }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'quiz' && (
              <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} className="t-checkbox" />
                Add a timer
              </label>
            )}

            {(mode === 'exam' || timed) && (
              <div className="w-full max-w-xs">
                <label className="block text-[0.62rem] font-black uppercase tracking-wider mb-1.5 text-left" style={{ color: 'var(--text-secondary)' }}>
                  Timer (minutes)
                </label>
                <input type="number" min={1} max={180} value={timerMinutes}
                  onChange={(e) => setTimerMinutes(Math.min(180, Math.max(1, Number(e.target.value) || 1)))}
                  className="t-input w-full px-4 py-2.5 rounded-xl text-sm" style={{ outline: 'none' }} />
              </div>
            )}
          </>
        }
      />
    );
  }

  // ── Results screen ───────────────────────────────────────────────────
  if (results) {
    const pct = Math.round((results.score / results.total) * 100);
    return (
      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        <div className="max-w-xl mx-auto">
          {results.progress_warning && (
            <div className="t-error rounded-xl px-4 py-3 mb-4 text-sm">
              Your assessment was saved, but learning progress could not be updated.
            </div>
          )}
          <div className="text-center mb-6">
            <p className="text-4xl font-black" style={{ color: 'var(--peak-active-text)' }}>{results.score}/{results.total}</p>
            <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-secondary)' }}>{pct}% correct</p>
            {results.completed_at && <time dateTime={results.completed_at} title={new Date(results.completed_at).toLocaleString()} className="block mt-1 text-[0.6rem]" style={{ color: 'var(--text-muted)' }}>Completed {formatTimestamp(results.completed_at)}</time>}
          </div>
          <div className="space-y-3">
            {results.results.map((r, i) => (
              <div key={r.question_id} className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-glass)' }}>
                <div className="flex items-start gap-2">
                  <i className={`fa-solid ${r.correct ? 'fa-circle-check' : 'fa-circle-xmark'} mt-0.5`} style={{ color: r.correct ? 'var(--success-text)' : 'var(--error-text)' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{i + 1}. {r.prompt}</p>
                    {!r.correct && <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Your answer: {r.given_answer || '(blank)'}</p>}
                    <p className="text-xs mt-1 font-semibold" style={{ color: 'var(--success-text)' }}>Correct: {r.correct_answer}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{r.feedback}</p>
                    <div className="flex items-center justify-between mt-2">
                      <p className="text-[0.6rem]" style={{ color: 'var(--text-muted)' }}>{r.citation ? formatDocumentCitation(r.citation) : 'Document source unavailable'}</p>
                      <button onClick={() => askTutorAbout(r)}
                        className="text-[0.65rem] font-bold flex items-center gap-1 shrink-0" style={{ color: 'var(--peak-active-text)' }}>
                        <i className="fa-solid fa-comment-dots" /> Explain in Tutor
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button onClick={startNewAssessment} disabled={generating} className="w-full mt-6 py-3 rounded-xl font-bold text-sm btn-primary transition disabled:opacity-50">
            {generating ? `Generating ${mode}…` : `Generate a new ${mode}`}
          </button>
        </div>
      </div>
    );
  }

  // ── In-progress screen ───────────────────────────────────────────────
  const answeredCount = Object.keys(answers).filter((k) => answers[k]?.trim()).length;
  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              {assessment.title} · {answeredCount}/{assessment.questions.length} answered
            </p>
            {assessment.created_at && <time dateTime={assessment.created_at} title={new Date(assessment.created_at).toLocaleString()} className="block mt-1 text-[0.58rem]" style={{ color: 'var(--text-muted)' }}>Generated {formatTimestamp(assessment.created_at)}</time>}
          </div>
          {secondsLeft !== null && (
            <p className="text-sm font-black" style={{ color: secondsLeft < 30 ? 'var(--error-text)' : 'var(--peak-active-text)' }}>
              <i className="fa-solid fa-clock mr-1.5" />{fmtTime(secondsLeft)}
            </p>
          )}
        </div>

        <div className="space-y-4">
          {assessment.questions.map((q, i) => (
            <div key={q.id} className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-glass)' }}>
              <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>{i + 1}. {q.prompt}</p>
              {q.type === 'multiple_choice' ? (
                <div className="space-y-2">
                  {q.options?.map((opt) => (
                    <label key={opt} className="flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer text-sm"
                      style={{ background: answers[q.id] === opt ? 'var(--peak-active-bg)' : 'var(--bg-input)', border: `1px solid ${answers[q.id] === opt ? 'var(--peak-active-border)' : 'var(--border-glass)'}`, color: 'var(--text-primary)' }}>
                      <input type="radio" name={q.id} checked={answers[q.id] === opt} onChange={() => setAnswers((a) => ({ ...a, [q.id]: opt }))} className="t-checkbox" />
                      {opt}
                    </label>
                  ))}
                </div>
              ) : (
                <input value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  placeholder="Your answer…" className="t-input w-full px-3 py-2.5 rounded-xl text-sm" style={{ outline: 'none' }} />
              )}
            </div>
          ))}
        </div>

        {error && <div className="mt-4 px-3 py-2 rounded-xl text-xs font-semibold t-error">{error}</div>}
        <button onClick={submit} disabled={submitting} className="w-full mt-5 py-3 rounded-xl font-bold text-sm btn-primary transition disabled:opacity-50">
          {submitting ? <><i className="fa-solid fa-spinner animate-spin mr-2" />Grading…</> : 'Submit'}
        </button>
      </div>
    </div>
  );
}
