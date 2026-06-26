import { NextRequest, NextResponse } from 'next/server';
import { ChatRequest, ChatResponse } from '@/lib/types';

export async function POST(request: NextRequest): Promise<NextResponse<ChatResponse>> {
  try {
    const body: ChatRequest = await request.json();
    const { message, conversationHistory, currentMealPlan } = body;

    // Validate required fields
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'Message is required.' },
        { status: 400 }
      );
    }

    if (!Array.isArray(conversationHistory)) {
      return NextResponse.json(
        { success: false, error: 'Conversation history must be an array.' },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('OPENAI_API_KEY is not configured');
      return NextResponse.json(
        { success: false, error: 'The AI service is not configured. Please contact support.' },
        { status: 500 }
      );
    }

    // Build the system prompt with meal plan context
    const systemPrompt = buildSystemPrompt(currentMealPlan);

    // Build messages array for OpenAI
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...conversationHistory.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      { role: 'user' as const, content: message },
    ];

    // Call OpenAI API with 60-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          temperature: 0.7,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const status = response.status;

        if (status === 429) {
          return NextResponse.json(
            { success: false, error: 'The service is busy. Please wait a moment and try again.' },
            { status: 429 }
          );
        }

        if (status >= 500) {
          return NextResponse.json(
            { success: false, error: 'The AI service is temporarily unavailable. Please try again later.' },
            { status: 502 }
          );
        }

        return NextResponse.json(
          { success: false, error: 'We received an unexpected response. Please try again.' },
          { status: 502 }
        );
      }

      const data = await response.json();

      if (!data.choices || !data.choices[0]?.message?.content) {
        return NextResponse.json(
          { success: false, error: 'We received an unexpected response. Please try again.' },
          { status: 502 }
        );
      }

      const reply = data.choices[0].message.content;

      return NextResponse.json({ success: true, reply });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return NextResponse.json(
          { success: false, error: 'The AI service is taking too long. Please try again.' },
          { status: 504 }
        );
      }

      throw fetchError;
    }
  } catch (error: unknown) {
    console.error('Chat API error:', error);
    return NextResponse.json(
      { success: false, error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    );
  }
}

function buildSystemPrompt(currentMealPlan: string): string {
  const mealPlanContext = currentMealPlan
    ? `\n\nHere is the patient's current meal plan that you helped generate:\n\n${currentMealPlan}\n\nWhen responding, reference specific items from this meal plan when relevant. You can suggest modifications, substitutions, or additions to the existing plan.`
    : '\n\nNo meal plan has been generated yet. Help the patient with general Crohn\'s-friendly nutrition advice.';

  return `You are a helpful and supportive meal planning assistant for Crohn's Disease patients. Your role is to help patients refine and adjust their personalized meal plans.

Key guidelines:
- Always be empathetic and understanding of the challenges Crohn's patients face with food
- Suggest Crohn's-friendly alternatives when patients express concerns about specific foods
- Consider common trigger foods (high-fiber, spicy, dairy, fatty foods) and offer gentler alternatives
- Keep suggestions practical and focused on the patient's specific needs
- If asked about medical advice, remind the patient to consult their doctor
- Reference the current meal plan when making suggestions or modifications
- Keep responses concise and actionable${mealPlanContext}`;
}
