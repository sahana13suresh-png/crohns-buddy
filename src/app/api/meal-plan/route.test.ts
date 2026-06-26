import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

// Mock quiz answers for testing
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

describe('/api/meal-plan', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key-123' };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns error when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toContain('not configured');
  });

  it('returns error for invalid JSON body', async () => {
    const req = new Request('http://localhost:3000/api/meal-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{{{',
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain('Invalid request body');
  });

  it('returns error when quizAnswers is missing', async () => {
    const req = createRequest({});
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain('Quiz answers are required');
  });

  it('returns a structured meal plan on successful OpenAI response', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: validMealPlanJSON } }],
        }),
        { status: 200 }
      )
    );

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.mealPlan).toBeDefined();
    expect(data.mealPlan.meals).toHaveLength(3);
    expect(data.mealPlan.meals[0].mealName).toBe('Breakfast');
    expect(data.mealPlan.meals[0].items[0].name).toBe('Oatmeal');
    expect(data.mealPlan.meals[0].items[0].portion).toBe('1 cup');
    expect(data.mealPlan.meals[0].items[0].notes).toBe('Cooked with water');
    expect(data.mealPlan.summary).toBe('A gentle, low-fiber meal plan focused on safe foods.');
    expect(data.mealPlan.warnings).toEqual(['Avoid peanuts due to allergy.']);

    // Verify the fetch was called with correct parameters
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-key-123',
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('handles meal plan JSON wrapped in code fences', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '```json\n' + validMealPlanJSON + '\n```' } }],
        }),
        { status: 200 }
      )
    );

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.mealPlan.meals).toHaveLength(3);
  });

  it('returns timeout error when request takes too long', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(504);
    expect(data.success).toBe(false);
    expect(data.error).toBe('The AI service is taking too long. Please try again.');
  });

  it('returns rate limit error on 429 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429 })
    );

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(429);
    expect(data.success).toBe(false);
    expect(data.error).toBe('The service is busy. Please wait a moment and try again.');
  });

  it('returns server error on 5xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Internal error' } }), { status: 500 })
    );

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.success).toBe(false);
    expect(data.error).toBe('The AI service is temporarily unavailable. Please try again later.');
  });

  it('returns malformed response error when AI returns invalid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'This is not JSON at all' } }],
        }),
        { status: 200 }
      )
    );

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.success).toBe(false);
    expect(data.error).toBe('We received an unexpected response. Please try again.');
  });

  it('returns malformed response error when AI returns incomplete meal plan', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ meals: [] }) } }],
        }),
        { status: 200 }
      )
    );

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.success).toBe(false);
    expect(data.error).toBe('We received an unexpected response. Please try again.');
  });

  it('returns malformed response error when OpenAI response has no choices', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), { status: 200 })
    );

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.success).toBe(false);
    expect(data.error).toBe('We received an unexpected response. Please try again.');
  });

  it('includes all quiz answer sections in the OpenAI request', async () => {
    let capturedBody: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, options) => {
      capturedBody = options?.body as string;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: validMealPlanJSON } }],
        }),
        { status: 200 }
      );
    });

    const req = createRequest({ quizAnswers: validQuizAnswers });
    await POST(req);

    expect(capturedBody).toBeDefined();
    const parsedBody = JSON.parse(capturedBody!);
    const userMessage = parsedBody.messages[1].content;

    // Verify all sections are included in the prompt
    expect(userMessage).toContain('Section 1: Current Crohn\'s Status');
    expect(userMessage).toContain('Section 2: Medical Safety');
    expect(userMessage).toContain('Section 3: Food Tolerance');
    expect(userMessage).toContain('Section 4: Food Preferences');
    expect(userMessage).toContain('Section 5: Lifestyle');
    expect(userMessage).toContain('Section 6: Output Preferences');

    // Verify specific answers are included
    expect(userMessage).toContain('remission');
    expect(userMessage).toContain('Mild fatigue');
    expect(userMessage).toContain('peanuts');
    expect(userMessage).toContain('white rice');
    expect(userMessage).toContain('College student on a budget');
  });

  it('handles network error gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const req = createRequest({ quizAnswers: validQuizAnswers });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.success).toBe(false);
    expect(data.error).toBe('The AI service is temporarily unavailable. Please try again later.');
  });
});
