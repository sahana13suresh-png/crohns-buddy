/**
 * Shared TypeScript interfaces for Crohn's Buddy
 */

// ─── Symptom Tracker ───────────────────────────────────────────────────────────

export interface TrackerEntry {
  date: string;            // ISO date string "YYYY-MM-DD"
  foodConsumed: string;    // Free text, max 500 chars
  painLevel: number;       // 1-10 scale
  bowelMovements: number;  // 0-20
  stressLevel: number;     // 1-10 scale
  energyLevel: number;     // 1-10 scale
  submittedAt: string;     // ISO datetime of submission
}

// ─── Quiz Answer Interfaces ────────────────────────────────────────────────────

export interface Section1Answers {
  flareStatus: 'active-flare' | 'remission' | 'unsure';
  currentSymptoms: string;
  symptomChecklist: string[];
  doctorDietInstructions: string;
}

export interface Section2Answers {
  surgeryOrObstruction: 'yes' | 'no' | 'unsure';
  recentWeightLoss: 'yes' | 'no';
  foodAllergies: string[];
  foodsToAvoid: string[];
}

export interface Section3Answers {
  safeFoods: string[];
  triggerFoods: string[];
  reintroduceFoods: string[];
  fiberTolerance: 'low' | 'moderate' | 'high';
}

export interface Section4Answers {
  preferredMealTypes: string[];
  refusedFoods: string[];
  proteinPreferences: string[];
  carbPreferences: string[];
}

export interface Section5Answers {
  mealPlanDuration: 'daily' | 'weekly' | '3-day';
  cookingTime: 'minimal' | 'moderate' | 'extended';
  applianceAccess: string[];
  mealsPerDay: number;
}

export interface Section6Answers {
  dietaryGoals: string[];
  outputFormat: 'simple-list' | 'detailed-recipes' | 'grocery-list';
  adventurousness: 'conservative' | 'moderate' | 'adventurous';
  extraNotes: string;
}

// ─── API Route Interfaces ──────────────────────────────────────────────────────

export interface MealPlanRequest {
  quizAnswers: {
    section1_crohnsStatus: Section1Answers;
    section2_medicalSafety: Section2Answers;
    section3_foodTolerance: Section3Answers;
    section4_foodPreferences: Section4Answers;
    section5_lifestyle: Section5Answers;
    section6_output: Section6Answers;
  };
}

export interface MealPlanResponse {
  success: boolean;
  mealPlan?: {
    meals: Array<{
      mealName: string;
      items: Array<{
        name: string;
        portion: string;
        notes?: string;
      }>;
    }>;
    summary: string;
    warnings?: string[];
  };
  error?: string;
}

export interface ChatRequest {
  message: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentMealPlan: string;
}

export interface ChatResponse {
  success: boolean;
  reply?: string;
  error?: string;
}

export interface ModerateRequest {
  text: string;
}

export interface ModerateResponse {
  approved: boolean;
  reason?: string;
}

// ─── Chat Forum ────────────────────────────────────────────────────────────────

export interface ForumMessage {
  id: string;
  displayName: string;       // 1-50 characters
  content: string;           // 1-2000 characters
  removed: boolean;
  removalNotice?: string;
  timestamp: Date;           // Client-side representation of Firestore Timestamp
}

// ─── AI Chat Session ───────────────────────────────────────────────────────────

export interface ChatSession {
  conversationHistory: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  currentMealPlan: string;
  isLoading: boolean;
}
