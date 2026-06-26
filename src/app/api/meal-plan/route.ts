import { NextResponse } from 'next/server';
import type { MealPlanRequest, MealPlanResponse } from '@/lib/types';

/**
 * POST /api/meal-plan
 *
 * Accepts structured quiz answers from the meal planner quiz,
 * builds a prompt, calls OpenAI GPT-4o-mini, and returns a
 * structured meal plan response.
 */
export async function POST(request: Request): Promise<NextResponse<MealPlanResponse>> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
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

    // Call OpenAI API with 60-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    let openAIResponse: Response;
    try {
      openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContext },
          ],
          temperature: 0.7,
          max_tokens: 2000,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        return NextResponse.json(
          { success: false, error: 'The AI service is taking too long. Please try again.' },
          { status: 504 }
        );
      }
      return NextResponse.json(
        { success: false, error: 'The AI service is temporarily unavailable. Please try again later.' },
        { status: 502 }
      );
    }

    clearTimeout(timeoutId);

    // Handle OpenAI API error responses
    if (!openAIResponse.ok) {
      if (openAIResponse.status === 429) {
        return NextResponse.json(
          { success: false, error: 'The service is busy. Please wait a moment and try again.' },
          { status: 429 }
        );
      }
      if (openAIResponse.status >= 500) {
        return NextResponse.json(
          { success: false, error: 'The AI service is temporarily unavailable. Please try again later.' },
          { status: 502 }
        );
      }
      return NextResponse.json(
        { success: false, error: 'The AI service is temporarily unavailable. Please try again later.' },
        { status: 502 }
      );
    }

    // Parse OpenAI response
    let openAIData: unknown;
    try {
      openAIData = await openAIResponse.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'We received an unexpected response. Please try again.' },
        { status: 502 }
      );
    }

    // Extract the AI-generated content
    const content = extractContent(openAIData);
    if (!content) {
      return NextResponse.json(
        { success: false, error: 'We received an unexpected response. Please try again.' },
        { status: 502 }
      );
    }

    // Parse the meal plan from the AI response
    const mealPlan = parseMealPlan(content);
    if (!mealPlan) {
      return NextResponse.json(
        { success: false, error: 'We received an unexpected response. Please try again.' },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, mealPlan });
  } catch {
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

Each meal should have 2-4 food items. Include portion sizes for every item.
The "warnings" array is optional but should be included if the patient has allergies, is in a flare, or has specific medical conditions.`;
}

/**
 * Builds the user context message from quiz answers, organized by section.
 */
function buildUserContext(quizAnswers: MealPlanRequest['quizAnswers']): string {
  const {
    section1_crohnsStatus,
    section2_medicalSafety,
    section3_foodTolerance,
    section4_foodPreferences,
    section5_lifestyle,
    section6_output,
  } = quizAnswers;

  return `Please generate a personalized meal plan based on the following patient information:

## Section 1: Current Crohn's Status
- Flare Status: ${section1_crohnsStatus.flareStatus}
- Current Symptoms: ${section1_crohnsStatus.currentSymptoms}
- Symptom Checklist: ${section1_crohnsStatus.symptomChecklist.join(', ') || 'None selected'}
- Doctor's Diet Instructions: ${section1_crohnsStatus.doctorDietInstructions}

## Section 2: Medical Safety
- History of Surgery/Obstruction: ${section2_medicalSafety.surgeryOrObstruction}
- Recent Weight Loss: ${section2_medicalSafety.recentWeightLoss}
- Food Allergies: ${section2_medicalSafety.foodAllergies.join(', ') || 'None'}
- Foods to Avoid (Medical): ${section2_medicalSafety.foodsToAvoid.join(', ') || 'None'}

## Section 3: Food Tolerance
- Safe Foods: ${section3_foodTolerance.safeFoods.join(', ') || 'None listed'}
- Trigger Foods: ${section3_foodTolerance.triggerFoods.join(', ') || 'None listed'}
- Foods to Reintroduce: ${section3_foodTolerance.reintroduceFoods.join(', ') || 'None'}
- Fiber Tolerance: ${section3_foodTolerance.fiberTolerance}

## Section 4: Food Preferences
- Preferred Meal Types: ${section4_foodPreferences.preferredMealTypes.join(', ') || 'No preference'}
- Refused Foods: ${section4_foodPreferences.refusedFoods.join(', ') || 'None'}
- Protein Preferences: ${section4_foodPreferences.proteinPreferences.join(', ') || 'No preference'}
- Carb Preferences: ${section4_foodPreferences.carbPreferences.join(', ') || 'No preference'}

## Section 5: Lifestyle
- Meal Plan Duration: ${section5_lifestyle.mealPlanDuration}
- Available Cooking Time: ${section5_lifestyle.cookingTime}
- Kitchen Appliances: ${section5_lifestyle.applianceAccess.join(', ') || 'Basic'}
- Meals Per Day: ${section5_lifestyle.mealsPerDay}

## Section 6: Output Preferences
- Dietary Goals: ${section6_output.dietaryGoals.join(', ') || 'General health'}
- Output Format: ${section6_output.outputFormat}
- Adventurousness: ${section6_output.adventurousness}
- Extra Notes: ${section6_output.extraNotes || 'None'}

Please generate a ${section5_lifestyle.mealPlanDuration} meal plan with ${section5_lifestyle.mealsPerDay} meals per day.`;
}

/**
 * Extracts the text content from an OpenAI API response.
 */
function extractContent(data: unknown): string | null {
  try {
    const obj = data as Record<string, unknown>;
    const choices = obj.choices as Array<Record<string, unknown>>;
    if (!choices || choices.length === 0) return null;
    const message = choices[0].message as Record<string, unknown>;
    if (!message) return null;
    return (message.content as string) || null;
  } catch {
    return null;
  }
}

/**
 * Parses the AI-generated content into a structured meal plan.
 * Handles cases where the AI might wrap JSON in code fences.
 */
function parseMealPlan(content: string): MealPlanResponse['mealPlan'] | null {
  try {
    // Strip markdown code fences if present
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    // Validate the structure
    if (!parsed.meals || !Array.isArray(parsed.meals) || parsed.meals.length === 0) {
      return null;
    }

    // Validate each meal has the required fields
    for (const meal of parsed.meals) {
      if (!meal.mealName || !Array.isArray(meal.items) || meal.items.length === 0) {
        return null;
      }
      for (const item of meal.items) {
        if (!item.name || !item.portion) {
          return null;
        }
      }
    }

    if (!parsed.summary || typeof parsed.summary !== 'string') {
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
  } catch {
    return null;
  }
}
