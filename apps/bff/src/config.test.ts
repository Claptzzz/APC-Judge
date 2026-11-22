import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const base = { KAFKA_BROKERS: 'localhost:9092' };

describe('loadConfig', () => {
  it('valores por defecto y group id único por réplica', () => {
    const c = loadConfig(base, 'bff-7f9c');
    expect(c).toMatchObject({
      nodeEnv: 'development',
      port: 4000,
      corsOrigins: ['http://localhost:5173'],
      grpc: { users: 'localhost:50051', ranking: 'localhost:50054', timeoutMs: 3000 },
      kafka: { brokers: ['localhost:9092'], clientId: 'bff', groupId: 'bff-bff-7f9c' },
      jwt: { issuer: 'juez-users', audience: 'juez' },
      graphql: { maxDepth: 10, introspection: true },
      assistant: { mcpUrl: 'http://localhost:4100/mcp', model: 'gemini-3.8-flash', maxRounds: 5 },
    });
  });

  it('CORS y brokers aceptan listas separadas por coma', () => {
    const c = loadConfig(
      { ...base, KAFKA_BROKERS: 'a:1, b:2', BFF_CORS_ORIGIN: 'http://a.cl, http://b.cl' },
      'h',
    );
    expect(c.kafka.brokers).toEqual(['a:1', 'b:2']);
    expect(c.corsOrigins).toEqual(['http://a.cl', 'http://b.cl']);
  });

  it('producción desactiva la introspección', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }, 'h').graphql.introspection).toBe(false);
  });

  it('Gemini con API key (AI Studio)', () => {
    const c = loadConfig({ ...base, GEMINI_API_KEY: 'k', GOOGLE_GENAI_USE_VERTEXAI: 'false' }, 'h');
    expect(c.assistant.gemini).toEqual({ mode: 'api-key', apiKey: 'k' });
  });

  it('Gemini con Vertex AI', () => {
    const c = loadConfig(
      {
        ...base,
        GOOGLE_GENAI_USE_VERTEXAI: 'true',
        GOOGLE_CLOUD_PROJECT: 'p',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
        GEMINI_API_KEY: 'ignorada',
      },
      'h',
    );
    expect(c.assistant.gemini).toEqual({ mode: 'vertex', project: 'p', location: 'us-central1' });
  });

  it('sin configuración de Gemini el BFF arranca igual con el asistente deshabilitado', () => {
    const sinKey = loadConfig({ ...base, GEMINI_API_KEY: '' }, 'h');
    expect(sinKey.assistant.gemini).toBeUndefined();
    expect(sinKey.assistant.disabledReason).toMatch(/GEMINI_API_KEY/);
    const vertexIncompleto = loadConfig(
      { ...base, GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_LOCATION: '' },
      'h',
    );
    expect(vertexIncompleto.assistant.gemini).toBeUndefined();
    expect(vertexIncompleto.assistant.disabledReason).toMatch(/GOOGLE_CLOUD_PROJECT/);
  });

  it('variables inválidas → ConfigError con el detalle', () => {
    expect(() => loadConfig({}, 'h')).toThrow(ConfigError);
    try {
      loadConfig({ ...base, BFF_PORT: 'abc', MCP_URL: 'no-url' }, 'h');
    } catch (err) {
      expect((err as ConfigError).issues.join('\n')).toMatch(/BFF_PORT/);
      expect((err as ConfigError).issues.join('\n')).toMatch(/MCP_URL/);
    }
  });
});
