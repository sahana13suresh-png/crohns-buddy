'use client';

import { useState, useCallback } from 'react';
import { quizSections } from '@/lib/quizConfig';
import QuizSection, { isQuestionAnswered } from './QuizSection';

export interface QuizFlowProps {
  onComplete: (answers: Record<string, Record<string, any>>) => void;
}

export default function QuizFlow({ onComplete }: QuizFlowProps) {
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Record<string, any>>>({});
  const [showErrors, setShowErrors] = useState(false);

  const totalSections = quizSections.length;
  const currentSection = quizSections[currentSectionIndex];
  const currentAnswers = answers[currentSection.id] ?? {};
  const isLastSection = currentSectionIndex === totalSections - 1;
  const isFirstSection = currentSectionIndex === 0;

  const handleAnswerChange = useCallback(
    (questionId: string, value: any) => {
      setAnswers((prev) => ({
        ...prev,
        [currentSection.id]: {
          ...(prev[currentSection.id] ?? {}),
          [questionId]: value,
        },
      }));
    },
    [currentSection.id]
  );

  const isSectionComplete = (sectionIndex: number): boolean => {
    const section = quizSections[sectionIndex];
    const sectionAnswers = answers[section.id] ?? {};
    return section.questions.every(
      (q) => !q.required || isQuestionAnswered(q, sectionAnswers[q.id])
    );
  };

  const handleNext = () => {
    if (!isSectionComplete(currentSectionIndex)) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setCurrentSectionIndex((prev) => Math.min(prev + 1, totalSections - 1));
  };

  const handlePrevious = () => {
    setShowErrors(false);
    setCurrentSectionIndex((prev) => Math.max(prev - 1, 0));
  };

  const handleGoToSection = (index: number) => {
    setShowErrors(false);
    setCurrentSectionIndex(index);
  };

  const handleGenerate = () => {
    if (!isSectionComplete(currentSectionIndex)) {
      setShowErrors(true);
      return;
    }
    onComplete(answers);
  };

  const progressPercent = ((currentSectionIndex + 1) / totalSections) * 100;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Progress Indicator */}
      <div className="space-y-2">
        <div className="flex justify-between items-center text-sm">
          <span className="font-medium text-brand-700">
            Section {currentSectionIndex + 1} of {totalSections}
          </span>
          <span className="text-brand-800/45">
            {totalSections - currentSectionIndex - 1} remaining
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-brand-100">
          <div
            className="h-full bg-brand-500 rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
            role="progressbar"
            aria-valuenow={currentSectionIndex + 1}
            aria-valuemin={1}
            aria-valuemax={totalSections}
            aria-label={`Progress: section ${currentSectionIndex + 1} of ${totalSections}`}
          />
        </div>

        {/* Section Navigation Dots */}
        <div className="flex justify-center gap-2 pt-1">
          {quizSections.map((section, index) => {
            const isActive = index === currentSectionIndex;
            const isCompleted = isSectionComplete(index);
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => handleGoToSection(index)}
                aria-label={`Go to ${section.title}${isCompleted ? ' (completed)' : ''}`}
                className={`w-3 h-3 rounded-full transition-all
                  ${isActive ? 'bg-brand-600 scale-125' : isCompleted ? 'bg-brand-300' : 'bg-brand-800/15'}
                  hover:scale-110`}
              />
            );
          })}
        </div>
      </div>

      {/* Section Content */}
      <div className="surface-card p-6 sm:p-8">
        <QuizSection
          section={currentSection}
          answers={currentAnswers}
          onAnswerChange={handleAnswerChange}
          showErrors={showErrors}
        />
      </div>

      {/* Navigation Buttons */}
      <div className="flex justify-between items-center">
        <button
          type="button"
          onClick={handlePrevious}
          disabled={isFirstSection}
          className={`rounded-full px-5 py-2.5 text-sm font-semibold transition-colors
            ${isFirstSection
              ? 'text-brand-800/30 cursor-not-allowed'
              : 'border border-brand-800/15 bg-white text-brand-700 hover:border-brand-300 hover:bg-brand-50'
            }`}
        >
          ← Previous
        </button>

        {isLastSection ? (
          <button
            type="button"
            onClick={handleGenerate}
            className="btn-primary"
          >
            Generate Meal Plan
          </button>
        ) : (
          <button
            type="button"
            onClick={handleNext}
            className="btn-primary"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}
