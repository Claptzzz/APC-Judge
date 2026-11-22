import { describe, expect, it } from 'vitest';
import { resolveGraphqlEndpoints } from './config';

const http = { href: 'http://localhost:5173/problems', protocol: 'http:', host: 'localhost:5173' };
const https = { href: 'https://juez.ucn.cl/contests/1', protocol: 'https:', host: 'juez.ucn.cl' };

describe('resolveGraphqlEndpoints', () => {
  it('usa /graphql relativo y deriva el WebSocket de window.location', () => {
    expect(resolveGraphqlEndpoints({}, http)).toEqual({
      httpUrl: '/graphql',
      wsUrl: 'ws://localhost:5173/graphql',
    });
    expect(resolveGraphqlEndpoints({}, https).wsUrl).toBe('wss://juez.ucn.cl/graphql');
  });

  it('ignora variables vacías', () => {
    expect(
      resolveGraphqlEndpoints({ VITE_GRAPHQL_URL: '  ', VITE_GRAPHQL_WS_URL: '' }, http).httpUrl,
    ).toBe('/graphql');
  });

  it('respeta las variables definidas', () => {
    expect(
      resolveGraphqlEndpoints(
        {
          VITE_GRAPHQL_URL: 'http://bff:4000/graphql',
          VITE_GRAPHQL_WS_URL: 'ws://bff:4000/graphql',
        },
        http,
      ),
    ).toEqual({ httpUrl: 'http://bff:4000/graphql', wsUrl: 'ws://bff:4000/graphql' });
  });

  it('sin VITE_GRAPHQL_WS_URL deriva el WebSocket de la URL HTTP absoluta', () => {
    expect(
      resolveGraphqlEndpoints({ VITE_GRAPHQL_URL: 'https://api.x.cl/graphql' }, http).wsUrl,
    ).toBe('wss://api.x.cl/graphql');
  });
});
