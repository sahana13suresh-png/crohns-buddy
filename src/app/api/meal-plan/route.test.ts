/**
 * Tests for `POST /api/meal-plan`, the unauthenticated generation endpoint.
 *
 * Two things are covered here. First, module evaluation supports either a Bedrock
 * API key or an AWS execution role. Second, the generation behavior over a mocked
 * Bedrock Converse endpoint: the
 * route carries no Session and reads no identity, because generating a Meal_Plan is
 * available to a visitor who is not signed in (Requirements 5.12, 6.10).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BEDROCK_TOKEN = 'test-bedrock-token';

/** Fresh module evaluation per load, so the module-scope assertion is observable. */
async function loadRoute(): Promise<typeof import('./route')> {
  vi.resetModules();
  return import('./route');
}

const validQuizAnswers = {
  section1_crohnsStatus: {
    flareStatus: 'remission' as const,
    currentSymptoms: 'Mild fatigue',
    symptomChecklist: ['Fatigue', 'Bloating'],
    doctorDietInstructions: 'Low fiber during flares',
  },
  section2_medicalSafety: {
    surgeryOrObstruction: 'no' as const,
    recentWeightLoss: 'no' as const,
    foodAllergies: ['peanuts'],
    foodsToAvoid: ['raw vegetables'],
  },
  section3_foodTolerance: {
    safeFoods: ['white rice', 'chicken'],
    triggerFoods: ['dairy', 'spicy foods'],
    reintroduceFoods: ['eggs'],
    fiberTolerance: 'low' as const,
  },
  section4_foodPreferences: {
    preferredMealTypes: ['Soup', 'Solid meals'],
    refusedFoods: ['mushrooms'],
    proteinPreferences: ['Chicken', 'Fish'],
    carbPreferences: ['White rice', 'Pasta'],
  },
  section5_lifestyle: {
    mealPlanDuration: 'daily' as const,
    cookingTime: 'moderate' as const,
    applianceAccess: ['Stove', 'Microwave'],
    mealsPerDay: 3,
  },
  section6_output: {
    dietaryGoals: ['Reduce inflammation'],
    outputFormat: 'simple-list' as const,
    adventurousness: 'conservative' as const,
    extraNotes: 'College student on a budget',
  },
};

const validMealPlanJSON = JSON.stringify({
  meals: [
    {
      mealName: 'Breakfast',
      items: [
        { name: 'Oatmeal', portion: '1 cup', notes: 'Cooked with water' },
        { name: 'Banana', portion: '1 medium' },
      ],
    },
    {
      mealName: 'Lunch',
      items: [
        { name: 'Grilled chicken', portion: '4 oz' },
        { name: 'White rice', portion: '1 cup' },
      ],
    },
    {
      mealName: 'Dinner',
      items: [
        { name: 'Salmon fillet', portion: '4 oz' },
        { name: 'Mashed potatoes', portion: '1 cup' },
      ],
    },
  ],
  summary: 'A gentle, low-fiber meal plan focused on safe foods.',
  warnings: ['Avoid peanuts due to allergy.'],
});

function createRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/meal-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A Bedrock Converse success envelope carrying `text` as the model's single content block. */
function converseResponse(text: string): Response {
  return new Response(
    JSON.stringify({ output: { message: { content: [{ text }] } } }),
    { status: 200 }
  );
}

/** Posts `body` through a freshly evaluated route module. */
async function post(body: unknown): Promise<Response> {
  const { POST } = await loadRoute();
  return POST(createRequest(body));
}

beforeEach(() => {
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', BEDROCK_TOKEN);
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6');
  // The Bedrock adapter logs the status and body of a non-ok response; the error-path tests
  // exercise that deliberately, so the output is suppressed rather than printed.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('startup credential validation', () => {
  it('supports execution-role authentication when the Bedrock token is unset', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined);

    const { POST } = await loadRoute();
    expect(typeof POST).toBe('function');
  });

  it('treats an empty Bedrock token as execution-role mode', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '');

    const { POST } = await loadRoute();
    expect(typeof POST).toBe('function');
  });

  it('evaluates and exports POST when the credential group is complete', async () => {
    const { POST } = await loadRoute();

    expect(typeof POST).toBe('function');
  });
});

describe('POST /api/meal-plan', () => {
  it('returns a structured meal plan, calling the Bedrock Converse endpoint with bearer auth', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(converseResponse(validMealPlanJSON));

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.mealPlan.meals).toHaveLength(3);
    expect(data.mealPlan.meals[0].mealName).toBe('Breakfast');
    expect(data.mealPlan.meals[0].items[0]).toEqual({
      name: 'Oatmeal',
      portion: '1 cup',
      notes: 'Cooked with water',
    });
    expect(data.mealPlan.summary).toBe('A gentle, low-fiber meal plan focused on safe foods.');
    expect(data.mealPlan.warnings).toEqual(['Avoid peanuts due to allergy.']);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-6/converse',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${BEDROCK_TOKEN}`,
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('generates for a caller carrying no Session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(converseResponse(validMealPlanJSON));
    const { POST } = await loadRoute();

    // No Authorization header, no cookie: generation is open to an unauthenticated visitor.
    const res = await POST(
      new Request('http://localhost:3000/api/meal-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizAnswers: validQuizAnswers }),
      })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('handles meal plan JSON wrapped in code fences', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      converseResponse('```json\n' + validMealPlanJSON + '\n```')
    );

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.mealPlan.meals).toHaveLength(3);
  });

  it('sends every quiz answer section in the Converse request', async () => {
    let capturedBody: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, options) => {
      capturedBody = options?.body as string;
      return converseResponse(validMealPlanJSON);
    });

    await post({ quizAnswers: validQuizAnswers });

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    const userMessage = parsed.messages[0].content[0].text;

    expect(parsed.system[0].text).toContain('nutrition assistant');
    expect(parsed.inferenceConfig).toEqual({ maxTokens: 8000, temperature: 0.7 });
    expect(userMessage).toContain("Section 1: Current Crohn's Status");
    expect(userMessage).toContain('Section 2: Medical Safety');
    expect(userMessage).toContain('Section 3: Food Tolerance');
    expect(userMessage).toContain('Section 4: Food Preferences');
    expect(userMessage).toContain('Section 5: Lifestyle');
    expect(userMessage).toContain('Section 6: Output Preferences');
    expect(userMessage).toContain('remission');
    expect(userMessage).toContain('Mild fatigue');
    expect(userMessage).toContain('peanuts');
    expect(userMessage).toContain('white rice');
    expect(userMessage).toContain('College student on a budget');
  });

  it('rejects an unparseable body as 400 without calling Bedrock', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { POST } = await loadRoute();

    const res = await POST(
      new Request('http://localhost:3000/api/meal-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{{{',
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain('Invalid request body');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing quizAnswers as 400 without calling Bedrock', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await post({});
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('Quiz answers are required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a throttled Bedrock response to 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Too many requests' }), { status: 429 })
    );

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(429);
    expect(data.error).toBe('The service is busy. Please wait a moment and try again.');
  });

  it('maps a Bedrock server error to 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Internal error' }), { status: 500 })
    );

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toBe('The AI service is temporarily unavailable. Please try again later.');
  });

  it('maps a request timeout to 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toBe('The AI service is temporarily unavailable. Please try again later.');
  });

  it('maps a network failure to 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toBe('The AI service is temporarily unavailable. Please try again later.');
  });

  it('maps a Converse envelope with no content block to 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ output: { message: { content: [] } } }), { status: 200 })
    );

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toBe('The AI service is temporarily unavailable. Please try again later.');
  });

  it('rejects model output that is not JSON as 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      converseResponse('This is not JSON at all')
    );

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toBe('We received an unexpected response. Please try again.');
  });

  it('rejects a plan carrying no meals as 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      converseResponse(JSON.stringify({ meals: [], summary: 'Empty' }))
    );

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toBe('We received an unexpected response. Please try again.');
  });

  it('rejects a meal item missing its portion as 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      converseResponse(
        JSON.stringify({
          meals: [{ mealName: 'Breakfast', items: [{ name: 'Oatmeal' }] }],
          summary: 'Missing a portion',
        })
      )
    );

    const res = await post({ quizAnswers: validQuizAnswers });
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error).toBe('We received an unexpected response. Please try again.');
  });
});
