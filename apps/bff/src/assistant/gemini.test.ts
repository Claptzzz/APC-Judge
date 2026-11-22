import type * as GenAI from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateContent = vi.fn();
const ctorArgs: unknown[] = [];

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof GenAI>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent };
      constructor(opts: unknown) {
        ctorArgs.push(opts);
      }
    },
  };
});

const { GeminiChatModel } = await import('./gemini.js');

beforeEach(() => {
  generateContent.mockReset();
  ctorArgs.length = 0;
});

describe('GeminiChatModel', () => {
  it('API key o Vertex AI según la configuración', () => {
    new GeminiChatModel({ mode: 'api-key', apiKey: 'k' }, 'gemini-x');
    new GeminiChatModel({ mode: 'vertex', project: 'p', location: 'us-central1' }, 'gemini-x');
    expect(ctorArgs).toEqual([
      { vertexai: false, apiKey: 'k' },
      { vertexai: true, project: 'p', location: 'us-central1' },
    ]);
  });

  it('declara las tools, pasa el abortSignal y separa texto de functionCalls', async () => {
    generateContent.mockResolvedValueOnce({
      modelVersion: 'gemini-x-001',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'pensando…', thought: true },
              { text: 'Voy a revisar ' },
              { text: 'tu submission.' },
              { functionCall: { name: 'ver_submission', args: { id: 's1' } } },
            ],
          },
        },
      ],
    });
    const model = new GeminiChatModel({ mode: 'api-key', apiKey: 'k' }, 'gemini-x');
    const signal = new AbortController().signal;
    const turn = await model.generate({
      contents: [{ role: 'user', parts: [{ text: 'hola' }] }],
      systemInstruction: 'sys',
      functionDeclarations: [{ name: 'ver_submission', parametersJsonSchema: { type: 'object' } }],
      forceText: false,
      signal,
    });
    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-x',
      contents: [{ role: 'user', parts: [{ text: 'hola' }] }],
      config: {
        systemInstruction: 'sys',
        abortSignal: signal,
        tools: [
          {
            functionDeclarations: [
              { name: 'ver_submission', parametersJsonSchema: { type: 'object' } },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
    });
    expect(turn.text).toBe('Voy a revisar tu submission.');
    expect(turn.functionCalls).toEqual([{ name: 'ver_submission', args: { id: 's1' } }]);
    expect(turn.modelVersion).toBe('gemini-x-001');
  });

  it('en la ronda final usa el modo NONE; sin tools no las declara', async () => {
    generateContent.mockResolvedValue({ candidates: [] });
    const model = new GeminiChatModel({ mode: 'api-key', apiKey: 'k' }, 'gemini-x');
    const signal = new AbortController().signal;
    await model.generate({
      contents: [],
      systemInstruction: 's',
      functionDeclarations: [{ name: 'a' }],
      forceText: true,
      signal,
    });
    expect(generateContent.mock.calls[0]![0].config.toolConfig).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    });
    const empty = await model.generate({
      contents: [],
      systemInstruction: 's',
      functionDeclarations: [],
      forceText: false,
      signal,
    });
    expect(generateContent.mock.calls[1]![0].config).toEqual({
      systemInstruction: 's',
      abortSignal: signal,
    });
    expect(empty).toEqual({
      content: undefined,
      functionCalls: [],
      text: '',
      modelVersion: undefined,
    });
  });
});
