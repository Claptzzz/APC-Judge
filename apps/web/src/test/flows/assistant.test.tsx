import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ASK_ASSISTANT } from '../../graphql/operations';
import { buildHistory } from '../../pages/AssistantPage';
import { makeSession } from '../fixtures';
import { renderApp, type Mock } from '../utils';

const answer = (
  message: string,
  toolCalls: Array<{ name: string; arguments: string; isError: boolean }> = [],
) => ({
  data: {
    askAssistant: {
      __typename: 'AssistantAnswer',
      message,
      toolCalls: toolCalls.map((t) => ({ __typename: 'AssistantToolCall', ...t })),
    },
  },
});

const ask = (message: string, history: unknown[], result: object): Mock => ({
  request: { query: ASK_ASSISTANT, variables: { message, history } },
  result,
});

const errorResult = (code: string, extra: Record<string, unknown> = {}) => ({
  errors: [{ message: code, extensions: { code, ...extra } }],
});

describe('asistente', () => {
  it('responde, muestra las tools como chips y envía el historial', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/assistant',
      session: makeSession(),
      mocks: [
        ask(
          '¿Cómo voy?',
          [],
          answer('Vas **primero** en la Copa.', [
            { name: 'ver_scoreboard', arguments: '{"contestId":"c1"}', isError: false },
            { name: 'ver_submission', arguments: '{"id":"x"}', isError: true },
          ]),
        ),
        ask(
          '¿Y el problema B?',
          [
            { role: 'USER', content: '¿Cómo voy?' },
            { role: 'ASSISTANT', content: 'Vas **primero** en la Copa.' },
          ],
          answer('Aún no lo resuelves.'),
        ),
      ],
    });

    await user.type(await screen.findByLabelText('Mensaje para el asistente'), '¿Cómo voy?{Enter}');
    expect(await screen.findByText('primero')).toBeInTheDocument();
    const chips = screen.getByRole('list', { name: 'Herramientas usadas' });
    expect(within(chips).getByText('ver_scoreboard')).toBeInTheDocument();
    expect(within(chips).getByText('ver_submission').closest('li')).toHaveAttribute(
      'title',
      'Argumentos: {"id":"x"}',
    );
    expect(within(chips).getByText('(falló)')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Mensaje para el asistente'), '¿Y el problema B?');
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Aún no lo resuelves.')).toBeInTheDocument();

    // El historial sobrevive a recargar la pantalla (sessionStorage).
    expect(sessionStorage.getItem('juez.assistant.u-contestant')).toContain('Aún no lo resuelves.');

    await user.click(screen.getByRole('button', { name: 'Nueva conversación' }));
    expect(screen.getByText('¿En qué te ayudo?')).toBeInTheDocument();
  });

  it('ASSISTANT_DISABLED muestra un mensaje claro', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/assistant',
      session: makeSession(),
      mocks: [ask('hola', [], errorResult('ASSISTANT_DISABLED'))],
    });
    await user.type(await screen.findByLabelText('Mensaje para el asistente'), 'hola{Enter}');
    expect(await screen.findByText('Asistente deshabilitado')).toBeInTheDocument();
    expect(screen.getByText(/El asistente está deshabilitado por ahora/)).toBeInTheDocument();
    expect(screen.getByText('Sin respuesta')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reintentar/ })).not.toBeInTheDocument();
  });

  it('rate limit: avisa, bloquea el reintento hasta que pase el tiempo y luego reintenta', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/assistant',
      session: makeSession(),
      mocks: [
        ask('hola', [], errorResult('RATE_LIMITED', { retryAfterSeconds: 1 })),
        ask('hola', [], answer('¡Hola!')),
      ],
    });
    await user.type(await screen.findByLabelText('Mensaje para el asistente'), 'hola{Enter}');
    expect(await screen.findByText('Demasiadas preguntas seguidas')).toBeInTheDocument();
    expect(screen.getByText(/Espera un momento antes de reintentar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reintentar en 1 s/ })).toBeDisabled();

    const retry = await screen.findByRole('button', { name: 'Reintentar' }, { timeout: 2500 });
    await user.click(retry);
    expect(await screen.findByText('¡Hola!')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Demasiadas preguntas seguidas')).not.toBeInTheDocument(),
    );
  });

  it('UNAVAILABLE se traduce y las sugerencias envían la pregunta', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/assistant',
      session: makeSession(),
      mocks: [ask('¿Qué problemas fáciles de grafos hay?', [], errorResult('UNAVAILABLE'))],
    });
    await user.click(
      await screen.findByRole('button', { name: '¿Qué problemas fáciles de grafos hay?' }),
    );
    expect(
      await screen.findByText('El servicio no está disponible, intenta en un momento.'),
    ).toBeInTheDocument();
  });
});

describe('buildHistory', () => {
  it('omite los mensajes fallidos y limita el largo', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      role: (i % 2 ? 'ASSISTANT' : 'USER') as 'USER' | 'ASSISTANT',
      content: `m${i}`,
      failed: i === 29,
    }));
    const history = buildHistory(msgs);
    expect(history).toHaveLength(20);
    expect(history.at(-1)).toEqual({ role: 'USER', content: 'm28' });
  });
});
