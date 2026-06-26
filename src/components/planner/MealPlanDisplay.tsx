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
      <div className="flex flex-col items-center justify-center py-12 space-y-4" role="status" aria-live="polite">
        <div className="w-10 h-10 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin" />
        <p className="text-brand-700 font-medium text-lg">
          Generating your personalized meal plan...
        </p>
        <p className="text-gray-500 text-sm">
          This may take a moment while we tailor recommendations to your needs.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6" role="alert" aria-live="assertive">
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
          className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
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
      <div className="bg-brand-50 border border-brand-200 rounded-lg p-4">
        <h3 className="text-brand-800 font-semibold text-lg mb-1">Plan Summary</h3>
        <p className="text-brand-700">{mealPlan.summary}</p>
      </div>

      {/* Warnings */}
      {mealPlan.warnings && mealPlan.warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4" role="alert">
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
            className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden"
          >
            <div className="bg-brand-600 px-4 py-2">
              <h3 className="text-white font-semibold">{meal.mealName}</h3>
            </div>
            <ul className="divide-y divide-gray-100 px-4">
              {meal.items.map((item, itemIndex) => (
                <li key={itemIndex} className="py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-900">{item.name}</span>
                    <span className="text-sm text-gray-500 whitespace-nowrap">
                      {item.portion}
                    </span>
                  </div>
                  {item.notes && (
                    <p className="text-sm text-gray-500 mt-0.5 italic">{item.notes}</p>
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
