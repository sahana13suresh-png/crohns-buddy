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
    section1_crohnsStatus?: Partial<Section1Answers>;
    section2_medicalSafety?: Partial<Section2Answers>;
    section3_foodTolerance?: Partial<Section3Answers>;
    section4_foodPreferences?: Partial<Section4Answers>;
    section5_lifestyle?: Partial<Section5Answers>;
    section6_output?: Partial<Section6Answers>;
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

// ─── Stored Meal Plans (cloud storage) ─────────────────────────────────────────
// `MealPlanContent` mirrors `MealPlanResponse['mealPlan']` exactly, so a stored
// plan renders through the same `MealPlanDisplay` component.

export interface MealPlanItemEntry {
  name: string;        // 1..200
  portion: string;     // 1..100
  notes?: string;      // 0..1000, absent when not present — Req 9.4
}

export interface MealEntry {
  mealName: string;              // 1..100
  items: MealPlanItemEntry[];    // 1..20, order significant
}

export interface MealPlanContent {
  meals: MealEntry[];        // 1..10, order significant
  summary: string;           // 0..5000
  warnings?: string[];       // 0..20, order significant, absent when none — Req 9.4
}

export interface MealPlanRecord {
  userId: string;            // partition key — Req 7.1
  mealPlanId: string;        // sort key, ULID, 26 chars [0-9A-Z] — Req 7.1, 7.8
  title: string;             // 1..100 as stored by the API; serializer accepts 1..200
  createdAt: string;         // ISO-8601 UTC, exactly 3 fractional digits — Req 9.1
  updatedAt: string;         // ISO-8601 UTC, exactly 3 fractional digits
  content: MealPlanContent;
}

export interface MealPlanSummary {   // list projection — Req 6.1
  mealPlanId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingDeletion {   // reserved PENDING#DELETION partition — Req 11.7
  userId: string;            // User_Id of the removed Account whose records remain
  attempts: number;          // purge attempts made so far
  enqueuedAt: string;        // ISO-8601 UTC, exactly 3 fractional digits
  nextAttemptAt: string;     // ISO-8601 UTC, exactly 3 fractional digits
}
