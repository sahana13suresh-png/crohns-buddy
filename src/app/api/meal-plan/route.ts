import { NextResponse } from 'next/server';
import type { MealPlanRequest, MealPlanResponse } from '@/lib/types';
import { invokeBedrockClaude } from '@/lib/bedrock';

/**
 * POST /api/meal-plan
 *
 * Accepts structured quiz answers from the meal planner quiz,
 * builds a prompt, calls Anthropic Claude via AWS Bedrock, and returns a
 * structured meal plan response.
 */
export async function POST(request: Request): Promise<NextResponse<MealPlanResponse>> {
  try {
    if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
      return NextResponse.json(
        { success: false, error: 'AI service is not configured. Please contact support.' },
        { status: 500 }
      );
    }

    // Parse and validate request body
    let body: MealPlanRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid request body.' },
        { status: 400 }
      );
    }

    if (!body.quizAnswers) {
      return NextResponse.json(
        { success: false, error: 'Quiz answers are required.' },
        { status: 400 }
      );
    }

    // Build the system prompt and user context
    const systemPrompt = buildSystemPrompt();
    const userContext = buildUserContext(body.quizAnswers);

    // Call Anthropic Claude via Bedrock
    let content: string;
    try {
      content = await invokeBedrockClaude({
        systemPrompt,
        messages: [{ role: 'user', content: userContext }],
        maxTokens: 8000,
        temperature: 0.7,
      });
    } catch (error: unknown) {
      console.error('Bedrock API error:', error);
      if (error instanceof Error && error.name === 'ThrottlingException') {
        return NextResponse.json(
          { success: false, error: 'The service is busy. Please wait a moment and try again.' },
          { status: 429 }
        );
      }
      return NextResponse.json(
        { success: false, error: 'The AI service is temporarily unavailable. Please try again later.' },
        { status: 502 }
      );
    }

    // Parse the meal plan from the AI response
    console.log('[meal-plan] AI response length:', content.length, 'Preview:', content.slice(0, 100));
    const mealPlan = parseMealPlan(content);
    if (!mealPlan) {
      return NextResponse.json(
        { success: false, error: 'We received an unexpected response. Please try again.' },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, mealPlan });
  } catch (err) {
    console.error('Meal plan route unexpected error:', err);
    return NextResponse.json(
      { success: false, error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * Builds the system prompt instructing the AI to generate a structured meal plan.
 */
function buildSystemPrompt(): string {
  return `You are a helpful nutrition assistant specializing in meal planning for Crohn's Disease patients. 
You create personalized meal plans based on the patient's symptoms, tolerances, preferences, and lifestyle.

IMPORTANT RULES:
- Always prioritize patient safety. Never suggest foods they listed as allergens or must-avoid.
- Consider their current flare status when recommending foods.
- Respect their food preferences and refused foods.
- Match cooking complexity to their available time and appliances.
- Generate the number of meals per day they requested.

You MUST respond with ONLY a valid JSON object in the following format (no markdown, no code fences, no extra text):
{
  "meals": [
    {
      "mealName": "Breakfast",
      "items": [
        { "name": "Food item name", "portion": "Portion size", "notes": "Optional preparation notes" }
      ]
    }
  ],
  "summary": "A brief 1-2 sentence summary of the meal plan approach",
  "warnings": ["Optional array of important dietary warnings or reminders"]
}

Each meal should have 2-4 food items. Include portion sizes for every item. Keep "notes" brief (under 10 words each).
The "warnings" array is optional but should be included if the patient has allergies, is in a flare, or has specific medical conditions.
IMPORTANT: Respond with ONLY the raw JSON. Do NOT wrap it in code fences or markdown.`;
}

/**
 * Builds the user context message from quiz answers, organized by section.
 * Safely handles missing/undefined fields.
 */
function buildUserContext(quizAnswers: MealPlanRequest['quizAnswers']): string {
  const s1 = quizAnswers.section1_crohnsStatus || {};
  const s2 = quizAnswers.section2_medicalSafety || {};
  const s3 = quizAnswers.section3_foodTolerance || {};
  const s4 = quizAnswers.section4_foodPreferences || {};
  const s5 = quizAnswers.section5_lifestyle || {};
  const s6 = quizAnswers.section6_output || {};

  const arr = (val: unknown): string => {
    if (Array.isArray(val) && val.length > 0) return val.join(', ');
    return 'Not specified';
  };

  const str = (val: unknown, fallback = 'Not specified'): string => {
    if (val && typeof val === 'string') return val;
    if (typeof val === 'number') return String(val);
    return fallback;
  };

  return `Please generate a personalized meal plan based on the following patient information:

## Section 1: Current Crohn's Status
- Flare Status: ${str(s1.flareStatus)}
- Current Symptoms: ${str(s1.currentSymptoms)}
- Symptom Checklist: ${arr(s1.symptomChecklist)}
- Doctor's Diet Instructions: ${str(s1.doctorDietInstructions)}

## Section 2: Medical Safety
- History of Surgery/Obstruction: ${str(s2.surgeryOrObstruction)}
- Recent Weight Loss: ${str(s2.recentWeightLoss)}
- Food Allergies: ${arr(s2.foodAllergies)}
- Foods to Avoid (Medical): ${arr(s2.foodsToAvoid)}

## Section 3: Food Tolerance
- Safe Foods: ${arr(s3.safeFoods)}
- Trigger Foods: ${arr(s3.triggerFoods)}
- Foods to Reintroduce: ${arr(s3.reintroduceFoods)}
- Fiber Tolerance: ${str(s3.fiberTolerance)}

## Section 4: Food Preferences
- Preferred Meal Types: ${arr(s4.preferredMealTypes)}
- Refused Foods: ${arr(s4.refusedFoods)}
- Protein Preferences: ${arr(s4.proteinPreferences)}
- Carb Preferences: ${arr(s4.carbPreferences)}

## Section 5: Lifestyle
- Meal Plan Duration: ${str(s5.mealPlanDuration, 'Daily plan')}
- Available Cooking Time: ${str(s5.cookingTime, 'Moderate')}
- Kitchen Appliances: ${typeof s5.applianceAccess === 'string' ? s5.applianceAccess : arr(s5.applianceAccess)}
- Meals Per Day: ${str(s5.mealsPerDay, '3')}

## Section 6: Output Preferences
- Dietary Goals: ${arr(s6.dietaryGoals)}
- Output Format: ${str(s6.outputFormat, 'Simple list of meals')}
- Adventurousness: ${str(s6.adventurousness, 'Moderate')}
- Extra Notes: ${str(s6.extraNotes, 'None')}

Please generate a ${str(s5.mealPlanDuration, 'daily')} meal plan with ${str(s5.mealsPerDay, '3')} meals per day.`;
}

/**
 * Parses the AI-generated content into a structured meal plan.
 * Handles cases where the AI might wrap JSON in code fences or add surrounding text.
 */
function parseMealPlan(content: string): MealPlanResponse['mealPlan'] | null {
  try {
    // Strip markdown code fences if present
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Try to extract JSON object if there's surrounding text
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    // Validate the structure
    if (!parsed.meals || !Array.isArray(parsed.meals) || parsed.meals.length === 0) {
      console.error('[parseMealPlan] Invalid structure: missing meals array');
      return null;
    }

    // Validate each meal has the required fields
    for (const meal of parsed.meals) {
      if (!meal.mealName || !Array.isArray(meal.items) || meal.items.length === 0) {
        console.error('[parseMealPlan] Invalid meal structure:', meal.mealName);
        return null;
      }
      for (const item of meal.items) {
        if (!item.name || !item.portion) {
          console.error('[parseMealPlan] Invalid item in meal:', item);
          return null;
        }
      }
    }

    if (!parsed.summary || typeof parsed.summary !== 'string') {
      console.error('[parseMealPlan] Missing or invalid summary');
      return null;
    }

    return {
      meals: parsed.meals.map((meal: Record<string, unknown>) => ({
        mealName: meal.mealName as string,
        items: (meal.items as Array<Record<string, unknown>>).map((item) => ({
          name: item.name as string,
          portion: item.portion as string,
          ...(item.notes ? { notes: item.notes as string } : {}),
        })),
      })),
      summary: parsed.summary as string,
      ...(parsed.warnings && Array.isArray(parsed.warnings) ? { warnings: parsed.warnings } : {}),
    };
  } catch (err) {
    console.error('[parseMealPlan] JSON parse error:', err, '\nContent preview:', content.slice(0, 200));
    return null;
  }
}
