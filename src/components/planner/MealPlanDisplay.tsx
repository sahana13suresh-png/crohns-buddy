'use client';

import { MealPlanResponse } from '@/lib/types';

export interface MealPlanDisplayProps {
  mealPlan: MealPlanResponse['mealPlan'] | null;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function MealPlanDisplay({
  mealPlan,
  isLoading,
  error,
  onRetry,
}: MealPlanDisplayProps) {
  if (isLoading) {
    return (
      <div className="surface-card flex flex-col items-center justify-center space-y-4 py-14 text-center" role="status" aria-live="polite">
        <div className="h-11 w-11 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
        <p className="text-brand-700 font-medium text-lg">
          Generating your personalized meal plan...
        </p>
        <p className="max-w-md text-sm text-brand-800/45">
          This may take a moment while we tailor recommendations to your needs.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert" aria-live="assertive">
        <div className="flex items-start gap-3">
          <svg
            className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0"
            fill="currentColor"
            viewBox="0 0 20 20"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
              clipRule="evenodd"
            />
          </svg>
          <div className="flex-1">
            <h3 className="text-red-800 font-semibold">Something went wrong</h3>
            <p className="text-red-700 mt-1">{error}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-full bg-red-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-800"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (!mealPlan) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="soft-panel">
        <h3 className="text-brand-800 font-semibold text-lg mb-1">Plan Summary</h3>
        <p className="leading-relaxed text-brand-800/65">{mealPlan.summary}</p>
      </div>

      {/* Warnings */}
      {mealPlan.warnings && mealPlan.warnings.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5" role="alert">
          <div className="flex items-start gap-2">
            <svg
              className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0"
              fill="currentColor"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
            <div>
              <h4 className="text-amber-800 font-semibold">Important Notes</h4>
              <ul className="mt-1 space-y-1">
                {mealPlan.warnings.map((warning, index) => (
                  <li key={index} className="text-amber-700 text-sm">
                    • {warning}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Meal Sections */}
      <div className="space-y-4">
        {mealPlan.meals.map((meal, mealIndex) => (
          <div
            key={mealIndex}
            className="overflow-hidden rounded-2xl border border-brand-800/10 bg-white shadow-[0_18px_50px_-35px_rgba(15,34,64,0.4)]"
          >
            <div className="flex items-center gap-3 bg-brand-800 px-5 py-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-white/80">
                {mealIndex + 1}
              </span>
              <h3 className="font-semibold text-white">{meal.mealName}</h3>
            </div>
            <ul className="divide-y divide-brand-800/10 px-5">
              {meal.items.map((item, itemIndex) => (
                <li key={itemIndex} className="py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-brand-800">{item.name}</span>
                    <span className="whitespace-nowrap text-sm text-brand-800/45">
                      {item.portion}
                    </span>
                  </div>
                  {item.notes && (
                    <p className="mt-1 text-sm italic text-brand-800/45">{item.notes}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
