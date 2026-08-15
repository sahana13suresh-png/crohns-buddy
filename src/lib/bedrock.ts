/**
 * AWS Bedrock client using API Key (Bearer Token) authentication.
 *
 * Required env vars:
 *   AWS_BEARER_TOKEN_BEDROCK - Your Bedrock API key (short-term or long-term)
 *
 * Optional:
 *   AWS_REGION - AWS region (defaults to us-east-1)
 *   BEDROCK_MODEL_ID - Anthropic model ID (defaults to Claude 3.5 Sonnet)
 */

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BedrockInvokeOptions {
  systemPrompt: string;
  messages: BedrockMessage[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * Invokes an Anthropic model via AWS Bedrock using Bearer Token (API Key) auth.
 */
export async function invokeBedrockClaude(
  options: BedrockInvokeOptions
): Promise<string> {
  const { systemPrompt, messages, maxTokens = 2000, temperature = 0.7 } = options;

  const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!apiKey) {
    throw new Error('AWS_BEARER_TOKEN_BEDROCK is not configured');
  }

  const region = process.env.AWS_REGION || DEFAULT_REGION;
  const modelId = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/converse`;

  const body = JSON.stringify({
    messages: messages.map((msg) => ({
      role: msg.role,
      content: [{ text: msg.content }],
    })),
    system: [{ text: systemPrompt }],
    inferenceConfig: {
      maxTokens,
      temperature,
    },
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Bedrock request timed out');
    }
    throw error;
  }

  clearTimeout(timeoutId);

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    console.error(`Bedrock API response error - Status: ${response.status}, Body: ${errorText}`);
    if (response.status === 429) {
      const err = new Error('Rate limited');
      err.name = 'ThrottlingException';
      throw err;
    }
    throw new Error(`Bedrock API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Converse API response format: { output: { message: { content: [{ text: "..." }] } } }
  if (data.output?.message?.content && data.output.message.content.length > 0) {
    return data.output.message.content[0].text;
  }

  throw new Error('No content in Bedrock response');
}
