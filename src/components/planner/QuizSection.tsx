'use client';

import { useState } from 'react';
import type { QuizSectionConfig, QuizQuestion } from '@/lib/quizConfig';

export interface QuizSectionProps {
  section: QuizSectionConfig;
  answers: Record<string, any>;
  onAnswerChange: (questionId: string, value: any) => void;
  showErrors: boolean;
}

function isQuestionAnswered(question: QuizQuestion, value: any): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function RadioQuestion({
  question,
  value,
  onChange,
  hasError,
}: {
  question: QuizQuestion;
  value: string | undefined;
  onChange: (val: string) => void;
  hasError: boolean;
}) {
  return (
    <fieldset className={`space-y-3 ${hasError ? 'ring-2 ring-red-200 rounded-xl p-3' : ''}`}>
      <legend className="text-sm font-semibold text-brand-800/75">{question.label}</legend>
      <div className="flex flex-wrap gap-3">
        {question.options?.map((option) => (
          <label
            key={option}
            className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3.5 py-2.5 transition-all
              ${value === option ? 'border-brand-500 bg-brand-50 text-brand-800 shadow-sm' : 'border-brand-800/15 bg-white hover:border-brand-300'}`}
          >
            <input
              type="radio"
              name={question.id}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm">{option}</span>
          </label>
        ))}
      </div>
      {hasError && <p className="text-red-600 text-xs mt-1">Please select an option.</p>}
    </fieldset>
  );
}

function CheckboxQuestion({
  question,
  value,
  onChange,
  hasError,
}: {
  question: QuizQuestion;
  value: string[] | undefined;
  onChange: (val: string[]) => void;
  hasError: boolean;
}) {
  const selected = value ?? [];

  const toggle = (option: string) => {
    if (selected.includes(option)) {
      onChange(selected.filter((o) => o !== option));
    } else {
      onChange([...selected, option]);
    }
  };

  return (
    <fieldset className={`space-y-3 ${hasError ? 'ring-2 ring-red-200 rounded-xl p-3' : ''}`}>
      <legend className="text-sm font-semibold text-brand-800/75">{question.label}</legend>
      <div className="flex flex-wrap gap-2">
        {question.options?.map((option) => (
          <label
            key={option}
            className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3.5 py-2.5 transition-all
              ${selected.includes(option) ? 'border-brand-500 bg-brand-50 text-brand-800 shadow-sm' : 'border-brand-800/15 bg-white hover:border-brand-300'}`}
          >
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() => toggle(option)}
              className="text-brand-600 focus:ring-brand-500 rounded"
            />
            <span className="text-sm">{option}</span>
          </label>
        ))}
      </div>
      {hasError && <p className="text-red-600 text-xs mt-1">Please select at least one option.</p>}
    </fieldset>
  );
}

function TextQuestion({
  question,
  value,
  onChange,
  hasError,
}: {
  question: QuizQuestion;
  value: string | undefined;
  onChange: (val: string) => void;
  hasError: boolean;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={question.id} className="text-sm font-semibold text-brand-800/75">
        {question.label}
      </label>
      <textarea
        id={question.id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={question.placeholder}
        rows={3}
        className={`field-control resize-y
          ${hasError ? 'border-red-400 ring-2 ring-red-200' : ''}`}
      />
      {hasError && <p className="text-red-600 text-xs">This field is required.</p>}
    </div>
  );
}

function NumberQuestion({
  question,
  value,
  onChange,
  hasError,
}: {
  question: QuizQuestion;
  value: number | undefined;
  onChange: (val: number) => void;
  hasError: boolean;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={question.id} className="text-sm font-semibold text-brand-800/75">
        {question.label}
      </label>
      <input
        id={question.id}
        type="number"
        value={value ?? ''}
        min={question.min}
        max={question.max}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`field-control w-32
          ${hasError ? 'border-red-400 ring-2 ring-red-200' : ''}`}
      />
      {question.min !== undefined && question.max !== undefined && (
        <p className="text-xs text-brand-800/45">Range: {question.min} – {question.max}</p>
      )}
      {hasError && <p className="text-red-600 text-xs">Please enter a valid number.</p>}
    </div>
  );
}

function TagInputQuestion({
  question,
  value,
  onChange,
  hasError,
}: {
  question: QuizQuestion;
  value: string[] | undefined;
  onChange: (val: string[]) => void;
  hasError: boolean;
}) {
  const tags = value ?? [];
  const [inputValue, setInputValue] = useState('');

  const addTag = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(inputValue);
      setInputValue('');
    } else if (e.key === 'Backspace' && inputValue === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div className="space-y-1">
      <label htmlFor={question.id} className="text-sm font-semibold text-brand-800/75">
        {question.label}
      </label>
      <div
        className={`flex min-h-[48px] flex-wrap gap-1 rounded-xl border bg-white p-2 transition-all
          ${hasError ? 'border-red-400 ring-2 ring-red-200' : 'border-brand-800/15 focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-200/60'}`}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-1 bg-brand-100 text-brand-700 text-xs rounded-full"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-brand-500 hover:text-brand-700"
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={question.id}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (inputValue.trim()) {
              addTag(inputValue);
              setInputValue('');
            }
          }}
          placeholder={tags.length === 0 ? question.placeholder : ''}
          className="flex-1 min-w-[120px] px-1 py-1 text-sm outline-none"
        />
      </div>
      <p className="text-xs text-brand-800/45">Press Enter or comma to add items.</p>
      {hasError && <p className="text-red-600 text-xs">Please add at least one item.</p>}
    </div>
  );
}

export default function QuizSection({ section, answers, onAnswerChange, showErrors }: QuizSectionProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-brand-800">{section.title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-brand-800/55">{section.description}</p>
      </div>

      <div className="space-y-5">
        {section.questions.map((question) => {
          const value = answers[question.id];
          const hasError = showErrors && question.required && !isQuestionAnswered(question, value);

          switch (question.type) {
            case 'radio':
              return (
                <RadioQuestion
                  key={question.id}
                  question={question}
                  value={value}
                  onChange={(val) => onAnswerChange(question.id, val)}
                  hasError={hasError}
                />
              );
            case 'checkbox':
              return (
                <CheckboxQuestion
                  key={question.id}
                  question={question}
                  value={value}
                  onChange={(val) => onAnswerChange(question.id, val)}
                  hasError={hasError}
                />
              );
            case 'text':
              return (
                <TextQuestion
                  key={question.id}
                  question={question}
                  value={value}
                  onChange={(val) => onAnswerChange(question.id, val)}
                  hasError={hasError}
                />
              );
            case 'number':
              return (
                <NumberQuestion
                  key={question.id}
                  question={question}
                  value={value}
                  onChange={(val) => onAnswerChange(question.id, val)}
                  hasError={hasError}
                />
              );
            case 'tag-input':
              return (
                <TagInputQuestion
                  key={question.id}
                  question={question}
                  value={value}
                  onChange={(val) => onAnswerChange(question.id, val)}
                  hasError={hasError}
                />
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

export { isQuestionAnswered };
