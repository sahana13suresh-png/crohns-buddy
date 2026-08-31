import { NextRequest, NextResponse } from 'next/server';
import { ChatRequest, ChatResponse } from '@/lib/types';
import { invokeBedrockClaude } from '@/lib/bedrock';
import { buildCrohnsSystemPrompt } from '@/lib/chatPolicy';

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

    // Build the system prompt with meal plan context
    const systemPrompt = buildCrohnsSystemPrompt(currentMealPlan);

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
        temperature: 0.3,
      });

      return NextResponse.json({ success: true, reply });
    } catch (error: unknown) {
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
  } catch {
    return NextResponse.json(
      { success: false, error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    );
  }
}
