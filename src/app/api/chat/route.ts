import { NextRequest, NextResponse } from 'next/server';
import { ChatRequest, ChatResponse } from '@/lib/types';
import { invokeBedrockClaude } from '@/lib/bedrock';

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

    if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
      console.error('AWS_BEARER_TOKEN_BEDROCK is not configured');
      return NextResponse.json(
        { success: false, error: 'The AI service is not configured. Please contact support.' },
        { status: 500 }
      );
    }

    // Build the system prompt with meal plan context
    const systemPrompt = buildSystemPrompt(currentMealPlan);

    // Build messages array for Bedrock (Anthropic format)
    const messages = [
      ...conversationHistory.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      { role: 'user' as const, content: message },
    ];

    // Call Anthropic Claude via Bedrock
    try {
      const reply = await invokeBedrockClaude({
        systemPrompt,
        messages,
        maxTokens: 1024,
        temperature: 0.7,
      });

      return NextResponse.json({ success: true, reply });
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
