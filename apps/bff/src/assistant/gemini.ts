import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';
import type { Content, FunctionCall, FunctionDeclaration } from '@google/genai';
import type { GeminiAuth } from '../config.js';

export interface GenerateParams {
  contents: Content[];
  systemInstruction: string;
  functionDeclarations: FunctionDeclaration[];
  /** Obliga a responder en texto (sin pedir más tools): se usa al llegar al tope de rondas. */
  forceText: boolean;
  signal: AbortSignal;
}

export interface ModelTurn {
  /** Contenido del modelo tal cual (incluye las thought signatures que hay que devolver). */
  content: Content | undefined;
  functionCalls: FunctionCall[];
  text: string;
  modelVersion: string | undefined;
}

/** Lo mínimo que el asistente necesita de Gemini (se mockea en los tests). */
export interface ChatModel {
  readonly model: string;
  generate(params: GenerateParams): Promise<ModelTurn>;
}

/** Gemini con `@google/genai`: API key (AI Studio) o Vertex AI según la configuración. */
export class GeminiChatModel implements ChatModel {
  private readonly ai: GoogleGenAI;

  constructor(
    auth: GeminiAuth,
    readonly model: string,
  ) {
    this.ai =
      auth.mode === 'vertex'
        ? new GoogleGenAI({ vertexai: true, project: auth.project, location: auth.location })
        : new GoogleGenAI({ vertexai: false, apiKey: auth.apiKey });
  }

  async generate(params: GenerateParams): Promise<ModelTurn> {
    const hasTools = params.functionDeclarations.length > 0;
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: params.contents,
      config: {
        systemInstruction: params.systemInstruction,
        abortSignal: params.signal,
        ...(hasTools && {
          tools: [{ functionDeclarations: params.functionDeclarations }],
          toolConfig: {
            functionCallingConfig: {
              mode: params.forceText
                ? FunctionCallingConfigMode.NONE
                : FunctionCallingConfigMode.AUTO,
            },
          },
        }),
      },
    });
    const content = res.candidates?.[0]?.content;
    const parts = content?.parts ?? [];
    return {
      content,
      functionCalls: parts.flatMap((p) => (p.functionCall ? [p.functionCall] : [])),
      // Se arma a mano en vez de `res.text` (que avisa por consola si hay functionCall).
      text: parts
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join(''),
      modelVersion: res.modelVersion,
    };
  }
}
