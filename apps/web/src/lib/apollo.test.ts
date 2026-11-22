import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGIN, ME } from '../graphql/operations';
import { createApollo } from './apollo';

const endpoints = { httpUrl: 'http://bff.test/graphql', wsUrl: 'ws://bff.test/graphql' };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('createApollo', () => {
  it('envía el token como Authorization: Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          me: {
            __typename: 'User',
            id: '1',
            username: 'a',
            email: null,
            role: 'ADMIN',
            createdAt: 'x',
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client, wsClient } = createApollo({
      endpoints,
      getToken: () => 'tok',
      onUnauthenticated: vi.fn(),
    });
    const { data } = await client.query({ query: ME });
    expect(data?.me.username).toBe('a');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://bff.test/graphql');
    expect(new Headers((init as RequestInit).headers).get('authorization')).toBe('Bearer tok');
    await wsClient.dispose();
  });

  it('sin token no envía Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { me: null } }));
    vi.stubGlobal('fetch', fetchMock);
    const { client, wsClient } = createApollo({
      endpoints,
      getToken: () => null,
      onUnauthenticated: vi.fn(),
    });
    await client.query({ query: ME, errorPolicy: 'all' }).catch(() => undefined);
    expect(
      new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).has('authorization'),
    ).toBe(false);
    await wsClient.dispose();
  });

  it('avisa cuando el servidor rechaza el token, pero no en el login', async () => {
    const unauthenticated = {
      errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(unauthenticated)),
    );
    const onUnauthenticated = vi.fn();
    const { client, wsClient } = createApollo({
      endpoints,
      getToken: () => 'tok',
      onUnauthenticated,
    });

    await expect(client.query({ query: ME })).rejects.toThrow();
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);

    await expect(
      client.mutate({
        mutation: LOGIN,
        variables: { input: { usernameOrEmail: 'a', password: 'b' } },
      }),
    ).rejects.toThrow();
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    await wsClient.dispose();
  });
});
