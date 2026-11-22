import { ApolloLink } from '@apollo/client';
import { MockLink, MockSubscriptionLink } from '@apollo/client/testing';
import { getMainDefinition } from '@apollo/client/utilities';
import { MockedProvider } from '@apollo/client/testing/react';
import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App';
import { ME } from '../graphql/operations';
import { AuthProvider } from '../lib/auth';
import { saveSession, type Session } from '../lib/session';
import { ThemeProvider } from '../lib/theme';
import { userFixture } from './fixtures';

export type Mock = MockLink.MockedResponse;

/** Mock de `me` (lo pide AuthProvider al montar con sesión). */
export function meMock(session: Session): Mock {
  return {
    request: { query: ME },
    result: { data: { me: userFixture(session) } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

export interface RenderAppOptions {
  route?: string;
  mocks?: Mock[];
  session?: Session | null;
  link?: ApolloLink;
  /** Reemplaza el mock por defecto de `me` (p. ej. para simular un token rechazado). */
  me?: Mock;
}

/** Monta la app completa (rutas reales) con Apollo mockeado y la sesión indicada. */
export function renderApp({
  route = '/',
  mocks = [],
  session = null,
  link,
  me,
}: RenderAppOptions = {}) {
  if (session) saveSession(session);
  const allMocks = session ? [me ?? meMock(session), ...mocks] : mocks;
  return render(
    <MockedProvider {...(link ? { link } : { mocks: allMocks })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[route]}>
          <AuthProvider>
            <App />
            <LocationProbe />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>
    </MockedProvider>,
  );
}

/**
 * Link para tests con subscriptions: queries/mutations van a un MockLink y las subscriptions
 * a un MockSubscriptionLink que el test controla con `simulateResult`.
 */
export function splitTestLink(mocks: Mock[], session: Session | null) {
  const subscriptions = new MockSubscriptionLink();
  const queries = new MockLink(session ? [meMock(session), ...mocks] : mocks);
  const link = ApolloLink.split(
    (op) => {
      const def = getMainDefinition(op.query);
      return def.kind === 'OperationDefinition' && def.operation === 'subscription';
    },
    subscriptions,
    queries,
  );
  return { link, subscriptions };
}
