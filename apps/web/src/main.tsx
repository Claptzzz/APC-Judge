import { ApolloProvider } from '@apollo/client/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import './index.css';
import { createApollo } from './lib/apollo';
import { AuthProvider, UNAUTHENTICATED_EVENT } from './lib/auth';
import { resolveGraphqlEndpoints } from './lib/config';
import { currentToken } from './lib/session';
import { ThemeProvider } from './lib/theme';

const endpoints = resolveGraphqlEndpoints(import.meta.env, window.location);
const { client, wsClient } = createApollo({
  endpoints,
  getToken: currentToken,
  onUnauthenticated: () => window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT)),
});

// Tras login/logout se cierra el WebSocket para reabrirlo con el token nuevo.
const restartWs = () => wsClient.terminate();

const root = document.getElementById('root');
if (!root) throw new Error('Falta #root en index.html');

createRoot(root).render(
  <StrictMode>
    <ApolloProvider client={client}>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider onSessionChange={restartWs}>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ApolloProvider>
  </StrictMode>,
);
