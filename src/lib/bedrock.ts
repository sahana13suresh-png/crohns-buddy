/**
 * AWS Bedrock client.
 *
 * Authentication is selected without weakening either deployment mode:
 *
 * - `AWS_BEARER_TOKEN_BEDROCK` present: use the Bedrock API-key endpoint. This
 *   preserves the existing local/Vercel workflow.
 * - token absent: use the AWS SDK default credential provider. On Amplify
 *   Hosting this resolves the app's least-privilege SSR compute role.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
const BEDROCK_TIMEOUT_MS = 90_000;

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

let sdkClient: BedrockRuntimeClient | undefined;

function getSdkClient(): BedrockRuntimeClient {
  sdkClient ??= new BedrockRuntimeClient({
    region: process.env.AWS_REGION || DEFAULT_REGION,
    maxAttempts: 3,
  });
  return sdkClient;
}

/** Test seam; production code never supplies a client. */
export function setBedrockRuntimeClient(client: BedrockRuntimeClient | undefined): void {
  sdkClient = client;
}

function commandInput(options: BedrockInvokeOptions): ConverseCommandInput {
  const {
    systemPrompt,
    messages,
    maxTokens = 2000,
    temperature = 0.7,
  } = options;

  return {
    modelId: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    messages: messages.map((message) => ({
      role: message.role,
      content: [{ text: message.content }],
    })),
    system: [{ text: systemPrompt }],
    inferenceConfig: { maxTokens, temperature },
  };
}

function textFromOutput(output: unknown): string {
  if (output === null || typeof output !== 'object') {
    throw new Error('No content in Bedrock response');
  }

  const message = (output as { message?: unknown }).message;
  if (message === null || typeof message !== 'object') {
    throw new Error('No content in Bedrock response');
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error('No content in Bedrock response');
  }

  const block = content.find(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as { text?: unknown }).text === 'string'
  ) as { text: string } | undefined;

  if (block === undefined) {
    throw new Error('No content in Bedrock response');
  }
  return block.text;
}

async function invokeWithSdk(options: BedrockInvokeOptions): Promise<string> {
  const result = await getSdkClient().send(new ConverseCommand(commandInput(options)));
  return textFromOutput(result.output);
}

async function invokeWithApiKey(
  options: BedrockInvokeOptions,
  apiKey: string
): Promise<string> {
  const region = process.env.AWS_REGION || DEFAULT_REGION;
  const input = commandInput(options);
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${input.modelId}/converse`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BEDROCK_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messages: input.messages,
        system: input.system,
        inferenceConfig: input.inferenceConfig,
      }),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Bedrock request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (response.status === 429) {
      const error = new Error('Rate limited');
      error.name = 'ThrottlingException';
      throw error;
    }
    throw new Error(`Bedrock API error (${response.status})`);
  }

  const data: unknown = await response.json();
  if (data === null || typeof data !== 'object') {
    throw new Error('No content in Bedrock response');
  }
  return textFromOutput((data as { output?: unknown }).output);
}

export async function invokeBedrockClaude(
  options: BedrockInvokeOptions
): Promise<string> {
  const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
  return apiKey ? invokeWithApiKey(options, apiKey) : invokeWithSdk(options);
}
