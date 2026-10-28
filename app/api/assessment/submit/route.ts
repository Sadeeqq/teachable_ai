import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { gradeShortAnswers } from '@/lib/rag/generate';
import { updateProgress } from '@/lib/rag/progress';
import { apiAuthFailure, getApiUser } from '@/lib/supabase/api-auth';

export async function POST(request: Request) {
  const supabase = createClient();
  const { user, error: authError } = await getApiUser(supabase);
  if (!user) return apiAuthFailure(authError);

  const { assessment_id, answers } = await request.json() as {
    assessment_id: string; answers: { question_id: string; given_answer: string }[];
  };

  const { data: assessment } = await supabase.from('assessments').select('*').eq('id', assessment_id).single();
  if (!assessment) return NextResponse.json({ detail: 'Assessment not found.' }, { status: 404 });

  const questions = assessment.questions as any[];
  const answerMap = new Map(answers.map((a) => [a.question_id, a.given_answer]));

  // Grade multiple-choice immediately (exact match); batch short-answer
  // grading into a single LLM call rather than one call per question.
  const results: { question_id: string; correct: boolean; feedback: string }[] = [];
  const shortAnswerBatch: { index: number; prompt: string; correctAnswer: string; givenAnswer: string }[] = [];
  const shortAnswerIds: string[] = [];

  questions.forEach((q) => {
    const given = (answerMap.get(q.id) ?? '').trim();
    if (q.type === 'multiple_choice') {
      results.push({
        question_id: q.id,
        correct: given.toLowerCase() === String(q.correct_answer).trim().toLowerCase(),
        feedback: q.explanation,
      });
    } else {
      shortAnswerBatch.push({ index: shortAnswerIds.length, prompt: q.prompt, correctAnswer: q.correct_answer, givenAnswer: given });
      shortAnswerIds.push(q.id);
      results.push({ question_id: q.id, correct: false, feedback: q.explanation }); // placeholder, filled below
    }
  });

  if (shortAnswerBatch.length) {
    try {
      const grades = await gradeShortAnswers(shortAnswerBatch);
      const gradesByIndex = new Map<number, (typeof grades)[number]>();
      for (const grade of grades) {
        if (!Number.isInteger(grade.index) || grade.index < 0 || grade.index >= shortAnswerIds.length ||
            typeof grade.correct !== 'boolean' || typeof grade.feedback !== 'string' || gradesByIndex.has(grade.index)) {
          throw new Error('The grader returned an invalid or duplicate result.');
        }
        gradesByIndex.set(grade.index, grade);
      }
      if (gradesByIndex.size !== shortAnswerBatch.length) {
        throw new Error('The grader did not return a result for every short answer.');
      }

      for (const [index, grade] of gradesByIndex) {
        const qid = shortAnswerIds[index];
        const result = results.find((item) => item.question_id === qid);
        if (result) {
          result.correct = grade.correct;
          result.feedback = grade.feedback || result.feedback;
        }
      }
    } catch (err: any) {
      console.error('[assessment-submit] Short-answer grading failed:', err.message);
      return NextResponse.json({
        detail: 'Short-answer grading failed, so this attempt was not saved. Please try submitting again.',
      }, { status: 502 });
    }
  }

  const total = questions.length;
  const score = results.filter((r) => r.correct).length;
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const resultsByQuestionId = new Map(results.map((result) => [result.question_id, result]));

  // Topic-level breakdown for student_progress (PRD §7).
  const topicBreakdown: Record<string, { correct: number; total: number }> = {};
  questions.forEach((q) => {
    const r = resultsByQuestionId.get(q.id)!;
    const t = q.topic || 'General';
    topicBreakdown[t] = topicBreakdown[t] ?? { correct: 0, total: 0 };
    topicBreakdown[t].total += 1;
    if (r.correct) topicBreakdown[t].correct += 1;
  });

  const detailedResults = results.map((result) => {
    const question = questionsById.get(result.question_id)!;
    return {
      ...result,
      prompt: question.prompt,
      correct_answer: question.correct_answer,
      given_answer: answerMap.get(result.question_id) ?? '',
      citation: question.citation ?? null,
    };
  });

  const completedAt = new Date().toISOString();
  const { error } = await supabase
    .from('study_sessions')
    .insert({
      chat_id: assessment.chat_id,
      subject_id: assessment.subject_id,
      user_id: user.id,
      mode: assessment.mode,
      assessment_id,
      score, total,
      topic_breakdown: topicBreakdown,
      answers: detailedResults,
      completed_at: completedAt,
    });
  if (error) return NextResponse.json({ detail: error.message }, { status: 500 });

  // Update rolling per-topic strength signal (PRD §7): blend new evidence
  // into the existing strength rather than overwriting it.
  const progressUpdates = await Promise.allSettled(
    Object.entries(topicBreakdown).map(([topic, stats]) =>
      updateProgress(supabase, user.id, assessment.subject_id, topic, stats.correct / stats.total),
    ),
  );
  const progressWarning = progressUpdates.some((result) => result.status === 'rejected');

  return NextResponse.json({
    score, total, completed_at: completedAt, progress_warning: progressWarning,
    results: detailedResults,
  });
}
