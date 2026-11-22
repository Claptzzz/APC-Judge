export interface GraphqlEndpoints {
  httpUrl: string;
  wsUrl: string;
}

interface EndpointEnv {
  VITE_GRAPHQL_URL?: string | undefined;
  VITE_GRAPHQL_WS_URL?: string | undefined;
}

type LocationLike = Pick<Location, 'href' | 'protocol' | 'host'>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Por defecto el front habla con `/graphql` en su mismo origen (proxy de Vite en desarrollo,
 * nginx en el contenedor). La URL de WebSocket se deriva de la HTTP resuelta contra
 * `window.location` (`http` → `ws`, `https` → `wss`). `VITE_GRAPHQL_URL` y
 * `VITE_GRAPHQL_WS_URL` las sobrescriben solo si están definidas.
 */
export function resolveGraphqlEndpoints(
  env: EndpointEnv,
  location: LocationLike,
): GraphqlEndpoints {
  const httpUrl = nonEmpty(env.VITE_GRAPHQL_URL) ?? '/graphql';
  const explicitWs = nonEmpty(env.VITE_GRAPHQL_WS_URL);
  if (explicitWs) return { httpUrl, wsUrl: explicitWs };

  const absolute = new URL(httpUrl, location.href);
  absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:';
  return { httpUrl, wsUrl: absolute.toString() };
}
