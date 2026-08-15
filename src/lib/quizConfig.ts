/**
 * Quiz configuration for the AI Meal Planner.
 *
 * Defines all 6 sections with 4 questions each (24 total).
 * Each question specifies its type, label, options (if applicable),
 * and validation requirements.
 */

export type QuestionType =
  | 'radio'        // Single selection from options
  | 'checkbox'     // Multiple selection from options
  | 'text'         // Free text input
  | 'number'       // Numeric input
  | 'tag-input';   // Multiple free-text entries (comma-separated or chip-based)

export interface QuizQuestion {
  id: string;
  label: string;
  type: QuestionType;
  options?: string[];
  placeholder?: string;
  required: boolean;
  min?: number;
  max?: number;
}

export interface QuizSectionConfig {
  id: string;
  title: string;
  description: string;
  questions: QuizQuestion[];
}

export const quizSections: QuizSectionConfig[] = [
  // ─── Section 1: Current Crohn's Status ─────────────────────────────────────
  {
    id: 'section1_crohnsStatus',
    title: "Current Crohn's Status",
    description: 'Tell us about your current condition so we can tailor your meal plan.',
    questions: [
      {
        id: 'flareStatus',
        label: 'Are you currently in a flare?',
        type: 'radio',
        options: ['Yes', 'No', 'Not sure', 'Recovering from a flare'],
        required: false,
      },
      {
        id: 'currentSymptoms',
        label: 'How would you describe your symptoms today?',
        type: 'radio',
        options: ['No symptoms', 'Mild', 'Moderate', 'Severe'],
        required: false,
      },
      {
        id: 'symptomChecklist',
        label: 'Select any symptoms you are currently experiencing:',
        type: 'checkbox',
        options: [
          'Abdominal pain',
          'Diarrhea',
          'Fatigue',
          'Nausea',
          'Bloating',
          'Loss of appetite',
          'Joint pain',
          'Fever',
          'Blood in stool',
          'Weight loss',
        ],
        required: false,
      },
      {
        id: 'doctorDietInstructions',
        label: 'Has your doctor given you specific diet instructions?',
        type: 'radio',
        options: ['Yes - low residue diet', 'Yes - liquid diet', 'Yes - other specific diet', 'No specific instructions', 'Not sure'],
        required: false,
      },
    ],
  },

  // ─── Section 2: Medical Safety Questions ───────────────────────────────────
  {
    id: 'section2_medicalSafety',
    title: 'Medical Safety Questions',
    description: 'These help us avoid suggesting foods that could be harmful.',
    questions: [
      {
        id: 'surgeryOrObstruction',
        label: 'Do you have a history of bowel surgery or obstruction?',
        type: 'radio',
        options: ['Yes', 'No', 'Not sure'],
        required: false,
      },
      {
        id: 'recentWeightLoss',
        label: 'Have you experienced significant unintentional weight loss recently?',
        type: 'radio',
        options: ['Yes', 'No'],
        required: false,
      },
      {
        id: 'foodAllergies',
        label: 'List any food allergies you have:',
        type: 'tag-input',
        placeholder: 'e.g., peanuts, shellfish, dairy...',
        required: false,
      },
      {
        id: 'foodsToAvoid',
        label: 'List any specific foods you must avoid (medical reasons):',
        type: 'tag-input',
        placeholder: 'e.g., high-fiber vegetables, raw foods...',
        required: false,
      },
    ],
  },

  // ─── Section 3: Food Tolerance ─────────────────────────────────────────────
  {
    id: 'section3_foodTolerance',
    title: 'Food Tolerance',
    description: 'Help us understand what your body handles well and what it doesn\'t.',
    questions: [
      {
        id: 'safeFoods',
        label: 'List foods you consider safe and well-tolerated:',
        type: 'tag-input',
        placeholder: 'e.g., white rice, bananas, chicken breast...',
        required: false,
      },
      {
        id: 'triggerFoods',
        label: 'List foods that you know trigger symptoms:',
        type: 'tag-input',
        placeholder: 'e.g., spicy foods, dairy, raw vegetables...',
        required: false,
      },
      {
        id: 'reintroduceFoods',
        label: 'Are there any foods you want to try reintroducing?',
        type: 'tag-input',
        placeholder: 'e.g., eggs, whole wheat bread...',
        required: false,
      },
      {
        id: 'fiberTolerance',
        label: 'How would you rate your current fiber tolerance?',
        type: 'radio',
        options: ['Low - I can only handle very low-fiber foods', 'Moderate - some fiber is okay', 'High - I tolerate most fiber well'],
        required: false,
      },
    ],
  },

  // ─── Section 4: Food Preferences ───────────────────────────────────────────
  {
    id: 'section4_foodPreferences',
    title: 'Food Preferences',
    description: 'Tell us what kinds of meals and foods you enjoy.',
    questions: [
      {
        id: 'preferredMealTypes',
        label: 'What types of meals do you like?',
        type: 'checkbox',
        options: ['Soup', 'Smoothie', 'Solid meals', 'Snacks', 'Salads', 'Wraps', 'Bowls', 'Sandwiches'],
        required: false,
      },
      {
        id: 'refusedFoods',
        label: 'List any foods you absolutely refuse to eat:',
        type: 'tag-input',
        placeholder: 'e.g., mushrooms, liver, tofu...',
        required: false,
      },
      {
        id: 'proteinPreferences',
        label: 'Select your preferred protein sources:',
        type: 'checkbox',
        options: ['Chicken', 'Fish', 'Tofu', 'Eggs', 'Beef', 'Turkey', 'Beans/Lentils', 'Pork'],
        required: false,
      },
      {
        id: 'carbPreferences',
        label: 'Select your preferred carbohydrate sources:',
        type: 'checkbox',
        options: ['White rice', 'Brown rice', 'Pasta', 'Bread', 'Potatoes', 'Oats', 'Quinoa'],
        required: false,
      },
    ],
  },

  // ─── Section 5: Lifestyle ──────────────────────────────────────────────────
  {
    id: 'section5_lifestyle',
    title: 'Lifestyle',
    description: 'Help us match the meal plan to your daily routine.',
    questions: [
      {
        id: 'mealPlanDuration',
        label: 'What type of meal plan do you need?',
        type: 'radio',
        options: ['Daily plan', 'Weekly plan', '3-day plan'],
        required: false,
      },
      {
        id: 'cookingTime',
        label: 'How much time do you have for cooking?',
        type: 'radio',
        options: ['Minimal (under 15 minutes)', 'Moderate (15-30 minutes)', 'Extended (30+ minutes)'],
        required: false,
      },
      {
        id: 'applianceAccess',
        label: 'Do you have access to a kitchen at school or work?',
        type: 'radio',
        options: ['Yes - full kitchen', 'Microwave only', 'No kitchen access'],
        required: false,
      },
      {
        id: 'mealsPerDay',
        label: 'How many meals per day do you typically eat?',
        type: 'number',
        min: 2,
        max: 6,
        required: false,
      },
    ],
  },

  // ─── Section 6: Meal Planner Output ────────────────────────────────────────
  {
    id: 'section6_output',
    title: 'Meal Planner Output',
    description: 'Customize how your meal plan is generated and presented.',
    questions: [
      {
        id: 'dietaryGoals',
        label: 'What are your primary dietary goals?',
        type: 'checkbox',
        options: [
          'Weight gain',
          'Reduce inflammation',
          'Increase energy',
          'Improve gut health',
          'Maintain weight',
          'Increase nutrient intake',
        ],
        required: false,
      },
      {
        id: 'outputFormat',
        label: 'How would you like your meal plan formatted?',
        type: 'radio',
        options: ['Simple list of meals', 'Detailed recipes with instructions', 'Grocery list included'],
        required: false,
      },
      {
        id: 'adventurousness',
        label: 'How adventurous are you with trying new foods?',
        type: 'radio',
        options: ['Conservative - stick to what I know works', 'Moderate - open to some new things', 'Adventurous - I want to explore new foods'],
        required: false,
      },
      {
        id: 'extraNotes',
        label: 'Any additional notes or preferences for the AI?',
        type: 'text',
        placeholder: 'e.g., I\'m a college student with a limited budget, I prefer quick meals...',
        required: false,
      },
    ],
  },
];

/**
 * Get the total number of questions across all sections.
 */
export function getTotalQuestionCount(): number {
  return quizSections.reduce((total, section) => total + section.questions.length, 0);
}

/**
 * Get a flat list of all question IDs grouped by section.
 */
export function getQuestionIdsBySection(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const section of quizSections) {
    result[section.id] = section.questions.map((q) => q.id);
  }
  return result;
}
