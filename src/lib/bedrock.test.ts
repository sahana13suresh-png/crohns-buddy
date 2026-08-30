import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invokeBedrockClaude,
  setBedrockRuntimeClient,
} from './bedrock';

const bedrock = mockClient(BedrockRuntimeClient);

const options = {
  systemPrompt: 'Be helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 120,
  temperature: 0.2,
};

beforeEach(() => {
  bedrock.reset();
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6');
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined);
  setBedrockRuntimeClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
});

afterEach(() => {
  setBedrockRuntimeClient(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('invokeBedrockClaude', () => {
  it('uses the SDK credential chain when no API key is configured', async () => {
    bedrock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Hello from Bedrock' }],
        },
      },
    });

    await expect(invokeBedrockClaude(options)).resolves.toBe('Hello from Bedrock');

    const input = bedrock.commandCalls(ConverseCommand)[0].args[0].input;
    expect(input.modelId).toBe('us.anthropic.claude-sonnet-4-6');
    expect(input.inferenceConfig).toEqual({ maxTokens: 120, temperature: 0.2 });
  });

  it('preserves the API-key request path for local development', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'test-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            message: { content: [{ text: 'Hello with an API key' }] },
          },
        }),
        { status: 200 }
      )
    );

    await expect(invokeBedrockClaude(options)).resolves.toBe('Hello with an API key');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-6/converse',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });
});
