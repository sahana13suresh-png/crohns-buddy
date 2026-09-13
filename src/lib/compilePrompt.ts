/**
 * Compiles quiz answers into a structured prompt string for AI meal plan generation.
 *
 * Iterates through all quiz sections and questions, formats each answer,
 * and produces a complete prompt ready to send to the AI.
 */

import { quizSections, QuizSectionConfig } from './quizConfig';
import type { MealPlanContent } from './types';

/** The shape of all quiz answers: section ID → question ID → answer value */
export type QuizAnswers = Record<string, Record<string, any>>;

/**
 * Formats a single answer value into a human-readable string.
 * - Arrays are joined as comma-separated lists
 * - Undefined/null/empty values return "Not specified"
 * - All other values are converted to string
 */
function formatAnswer(value: any): string {
  if (value === undefined || value === null || value === '') {
    return 'Not specified';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'None';
    }
    return value.join(', ');
  }
  return String(value);
}

/**
 * Maps meal plan duration values to user-friendly labels.
 */
function formatDuration(value: string): string {
  const durationMap: Record<string, string> = {
    daily: '1-day',
    '3-day': '3-day',
    weekly: '7-day',
  };
  return durationMap[value] || value;
}

/**
 * Compiles all quiz answers into a structured prompt string.
 *
 * @param answers - Record keyed by section ID, each containing question ID → answer pairs
 * @param sections - Quiz section configurations (defaults to quizSections from quizConfig)
 * @returns A complete structured prompt string ready for AI consumption
 */
export function compilePrompt(
  answers: QuizAnswers,
  sections: QuizSectionConfig[] = quizSections
): string {
  const lines: string[] = [];

  // Opening line
  lines.push("Create a personalized meal plan for someone with Crohn's disease.");
  lines.push('');

  // Iterate through each section and compile answers
  for (const section of sections) {
    const sectionAnswers = answers[section.id] || {};

    for (const question of section.questions) {
      const rawValue = sectionAnswers[question.id];

      // Special formatting for meal plan duration
      let formattedValue: string;
      if (question.id === 'mealPlanDuration' && typeof rawValue === 'string') {
        formattedValue = formatDuration(rawValue);
      } else {
        formattedValue = formatAnswer(rawValue);
      }

      // Map question IDs to prompt labels for a clean, readable prompt
      const label = getPromptLabel(section.id, question.id, question.label);
      lines.push(`${label}: ${formattedValue}`);
    }
  }

  // Add closing instructions
  lines.push('');
  lines.push(
    'Use only foods they tolerate or are comfortable trying. Avoid trigger foods and allergies. ' +
      'Keep the meals realistic, simple, and balanced. Include breakfast, lunch, dinner, snacks, and a grocery list. ' +
      'Add a reminder that this is not medical advice and should be reviewed with a doctor or registered dietitian.'
  );

  return lines.join('\n');
}

/**
 * Renders a stored Meal_Plan as the plan context for the AI chat
 * (Requirement 6.7).
 *
 * A reopened plan has no quiz answers behind it — only the stored content — so
 * `compilePrompt` cannot produce its context. The plan itself is the context
 * instead, written out in the order it is stored: meals, then the items within
 * each meal, then the warnings. That order is significant (Requirement 6.4), and
 * the chat sees the same sequence the Patient sees on screen.
 *
 * `notes` and `warnings` are omitted when absent rather than rendered as empty
 * lines, matching the absent-means-absent rule the serializer holds to.
 */
export function compileStoredPlanContext(plan: MealPlanContent): string {
  const lines: string[] = ['Current meal plan:'];

  if (plan.summary.trim().length > 0) {
    lines.push('', `Summary: ${plan.summary}`);
  }

  for (const meal of plan.meals) {
    lines.push('', `${meal.mealName}:`);
    for (const item of meal.items) {
      const notes = item.notes === undefined ? '' : ` (${item.notes})`;
      lines.push(`- ${item.name} — ${item.portion}${notes}`);
    }
  }

  if (plan.warnings !== undefined && plan.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of plan.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Maps section/question IDs to clean, concise prompt labels.
 * Falls back to the question label if no custom mapping exists.
 */
function getPromptLabel(sectionId: string, questionId: string, defaultLabel: string): string {
  const labelMap: Record<string, Record<string, string>> = {
    section1_crohnsStatus: {
      flareStatus: 'Current flare status',
      currentSymptoms: 'Symptoms description',
      symptomChecklist: 'Symptom checklist',
      doctorDietInstructions: 'Doctor diet instructions',
    },
    section2_medicalSafety: {
      surgeryOrObstruction: 'History of bowel surgery or obstruction',
      recentWeightLoss: 'Recent unintentional weight loss',
      foodAllergies: 'Food allergies',
      foodsToAvoid: 'Medical foods to avoid',
    },
    section3_foodTolerance: {
      safeFoods: 'Safe foods',
      triggerFoods: 'Trigger foods',
      reintroduceFoods: 'Foods to reintroduce',
      fiberTolerance: 'Fiber tolerance',
    },
    section4_foodPreferences: {
      preferredMealTypes: 'Preferred meal types',
      refusedFoods: 'Foods they refuse to eat',
      proteinPreferences: 'Protein preferences',
      carbPreferences: 'Carb preferences',
    },
    section5_lifestyle: {
      mealPlanDuration: 'Plan duration',
      cookingTime: 'Cooking time available',
      applianceAccess: 'Kitchen appliances available',
      mealsPerDay: 'Meals per day',
    },
    section6_output: {
      dietaryGoals: 'Dietary goals',
      outputFormat: 'Output format',
      adventurousness: 'Food adventurousness',
      extraNotes: 'Additional notes',
    },
  };

  const sectionLabels = labelMap[sectionId];
  if (sectionLabels && sectionLabels[questionId]) {
    return sectionLabels[questionId];
  }

  // Fallback: strip trailing colon/question mark from the question label
  return defaultLabel.replace(/[?:]$/, '').trim();
}

/**
 * Validates that all sections and questions have answers present.
 * Returns a list of missing entries as "sectionId.questionId" strings.
 */
export function findMissingAnswers(
  answers: QuizAnswers,
  sections: QuizSectionConfig[] = quizSections
): string[] {
  const missing: string[] = [];

  for (const section of sections) {
    const sectionAnswers = answers[section.id] || {};

    for (const question of section.questions) {
      const value = sectionAnswers[question.id];
      if (value === undefined || value === null || value === '') {
        missing.push(`${section.id}.${question.id}`);
      } else if (Array.isArray(value) && value.length === 0) {
        missing.push(`${section.id}.${question.id}`);
      }
    }
  }

  return missing;
}
