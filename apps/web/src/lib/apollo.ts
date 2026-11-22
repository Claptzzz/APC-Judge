import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from '@apollo/client';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { SetContextLink } from '@apollo/client/link/context';
import { ErrorLink } from '@apollo/client/link/error';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient, type Client as WsClient } from 'graphql-ws';
import type { GraphqlEndpoints } from './config';

export interface ApolloSetup {
  client: ApolloClient;
  wsClient: WsClient;
}

export interface ApolloSetupOptions {
  endpoints: GraphqlEndpoints;
  getToken: () => string | null;
  /** Se llama cuando el servidor rechaza un token que el cliente creía válido. */
  onUnauthenticated: () => void;
}

export function createCache(): InMemoryCache {
  return new InMemoryCache({
    typePolicies: {
      // Las filas y resultados del scoreboard no tienen `id`: se guardan dentro del padre.
      Scoreboard: { keyFields: ['contestId'] },
      ScoreboardRow: { keyFields: false },
      ProblemResult: { keyFields: false },
      ContestProblem: { keyFields: false },
      UserStats: { keyFields: ['userId'] },
    },
  });
}

function isSubscription(operation: ApolloLink.Operation): boolean {
  const definition = getMainDefinition(operation.query);
  return definition.kind === 'OperationDefinition' && definition.operation === 'subscription';
}

export function createApollo({
  endpoints,
  getToken,
  onUnauthenticated,
}: ApolloSetupOptions): ApolloSetup {
  const wsClient = createClient({
    url: endpoints.wsUrl,
    lazy: true,
    // El token se lee al abrir cada conexión; tras login/logout se fuerza una conexión nueva.
    connectionParams: () => {
      const token = getToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
    retryAttempts: Infinity,
    shouldRetry: () => true,
    retryWait: async (retries) => {
      const delay = Math.min(30_000, 1000 * 2 ** retries) * (0.5 + Math.random() / 2);
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
  });

  const authLink = new SetContextLink((prevContext) => {
    const token = getToken();
    if (!token) return {};
    return {
      headers: {
        ...(prevContext.headers as Record<string, string>),
        authorization: `Bearer ${token}`,
      },
    };
  });

  const errorLink = new ErrorLink(({ error, operation }) => {
    if (!CombinedGraphQLErrors.is(error)) return;
    const unauthenticated = error.errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED');
    // En login/register UNAUTHENTICATED significa credenciales incorrectas, no sesión vencida.
    const isAuthOperation = ['Login', 'Register'].includes(operation.operationName ?? '');
    if (unauthenticated && !isAuthOperation && getToken()) onUnauthenticated();
  });

  const httpLink = ApolloLink.from([authLink, new HttpLink({ uri: endpoints.httpUrl })]);
  const wsLink = new GraphQLWsLink(wsClient);
  const link = ApolloLink.from([errorLink, ApolloLink.split(isSubscription, wsLink, httpLink)]);

  const client = new ApolloClient({ link, cache: createCache() });
  return { client, wsClient };
}
