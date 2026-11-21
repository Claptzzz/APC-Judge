import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { Difficulty } from '@juez/contracts/es';
import type { Problem, ScoreboardRow, Submission } from '@juez/contracts/es';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import { callOptions } from '../upstream/clients.js';
import type { UpstreamClients } from '../upstream/clients.js';
import { describeUpstreamError } from '../upstream/errors.js';
import type { UpstreamService } from '../upstream/errors.js';
import {
  DIFFICULTY_LABEL,
  formatMemory,
  isoDate,
  LANGUAGE_LABEL,
  nextPageHint,
  shortDate,
  truncate,
  truncationNotice,
  verdictInfo,
} from './format.js';

/** Identidad del usuario que llama, verificada antes de llegar al MCP server. */
export interface Caller {
  token: string;
  sub: string;
  username: string;
  role: string;
  requestId: string;
}

export interface ToolDeps {
  clients: UpstreamClients;
  timeoutMs: number;
  logger: Logger;
}

/** Todas las tools son de solo lectura: no cambian nada en el juez. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export const TOOL_NAMES = [
  'listar_problemas',
  'ver_problema',
  'mis_submissions',
  'ver_submission',
  'ver_scoreboard',
] as const;

const DIFFICULTY_ARG = {
  facil: Difficulty.EASY,
  media: Difficulty.MEDIUM,
  dificil: Difficulty.HARD,
} as const;

const pageToken = z
  .string()
  .max(1024)
  .optional()
  .describe(
    'Token de paginación devuelto por una llamada anterior para obtener la página siguiente.',
  );

function ok(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Error de una tool: resultado con `isError` (no error de protocolo) para que el LLM reaccione. */
class ToolFailure extends Error {
  override name = 'ToolFailure';
}

export function registerTools(server: McpServer, deps: ToolDeps, caller: Caller): void {
  const opts = () => callOptions(caller, deps.timeoutMs);
  const log = deps.logger.child({ sub: caller.sub, requestId: caller.requestId });

  /**
   * Ejecuta el cuerpo de una tool. Los errores de los servicios se devuelven como resultado
   * con `isError: true` y un mensaje entendible; se registran en el log con su causa.
   */
  async function run(
    tool: string,
    service: UpstreamService,
    notFound: string,
    body: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const started = performance.now();
    try {
      const result = await body();
      log.info({ tool, durationMs: Math.round(performance.now() - started) }, 'tool ejecutada');
      return result;
    } catch (err) {
      const message =
        err instanceof ToolFailure ? err.message : describeUpstreamError(err, service, notFound);
      log.warn(
        { tool, err, durationMs: Math.round(performance.now() - started) },
        'tool con error',
      );
      return fail(message);
    }
  }

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'listar_problemas',
    {
      title: 'Listar problemas',
      description:
        'Lista los problemas del juez con su título, slug, dificultad y etiquetas. Úsala para ' +
        'buscar problemas por tema o dificultad, o para recomendar qué practicar. No incluye ' +
        'los enunciados: para leer uno usa ver_problema con su id o slug.',
      inputSchema: z.object({
        tags: z
          .array(z.string().trim().min(1).max(50))
          .max(10)
          .optional()
          .describe('Etiquetas para filtrar, por ejemplo ["dp", "grafos"].'),
        dificultad: z
          .enum(['facil', 'media', 'dificil'])
          .optional()
          .describe('Filtra por dificultad: facil, media o dificil.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Problemas por página (1 a 50, por defecto 20).'),
        page_token: pageToken,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run('listar_problemas', 'problems', 'No se encontraron problemas.', async () => {
        const res = await deps.clients.problems.listProblems(
          {
            pageSize: args.page_size ?? 20,
            pageToken: args.page_token ?? '',
            tags: args.tags ?? [],
            difficulty: args.dificultad ? DIFFICULTY_ARG[args.dificultad] : Difficulty.UNSPECIFIED,
          },
          opts(),
        );
        const problems = res.problems.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          difficulty: DIFFICULTY_LABEL[p.difficulty] ?? 'sin dificultad',
          tags: p.tags,
          published: p.published,
        }));
        const lines = problems.map(
          (p) =>
            `- ${p.title} (slug: ${p.slug}, id: ${p.id}) — ${p.difficulty}` +
            (p.tags.length ? ` — etiquetas: ${p.tags.join(', ')}` : '') +
            (p.published ? '' : ' — NO publicado'),
        );
        const text = problems.length
          ? `${problems.length} problema(s):\n${lines.join('\n')}${nextPageHint(res.nextPageToken)}`
          : 'No hay problemas que coincidan con los filtros.';
        return ok(text, { problems, next_page_token: res.nextPageToken });
      }),
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'ver_problema',
    {
      title: 'Ver problema',
      description:
        'Muestra un problema completo: enunciado, límites de tiempo y memoria, ejemplos de ' +
        'entrada/salida, dificultad y etiquetas. Úsala cuando el usuario pregunte por un ' +
        'problema concreto o para entender qué pide antes de explicar una submission. ' +
        'Indica exactamente uno: id (UUID) o slug.',
      inputSchema: z
        .object({
          id: z.uuid().optional().describe('UUID del problema.'),
          slug: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .optional()
            .describe('Slug del problema, por ejemplo "suma-de-dos-numeros".'),
        })
        .refine((a) => (a.id === undefined) !== (a.slug === undefined), {
          message: 'Indica exactamente uno: id o slug.',
        }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const ref = args.id ? `con id ${args.id}` : `con slug "${args.slug}"`;
      return run('ver_problema', 'problems', `El problema ${ref} no existe.`, async () => {
        const res = await deps.clients.problems.getProblem(
          {
            key: args.id
              ? { case: 'id', value: args.id }
              : { case: 'slug', value: args.slug ?? '' },
          },
          opts(),
        );
        if (!res.problem) throw new ToolFailure(`El problema ${ref} no existe.`);
        return formatProblem(res.problem);
      });
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'mis_submissions',
    {
      title: 'Mis submissions',
      description:
        'Lista las submissions (envíos de código) del usuario que está conversando, de la más ' +
        'reciente a la más antigua, con su veredicto, casos pasados, tiempo y memoria. ' +
        'Siempre son las del propio usuario: no permite ver las de otras personas. Filtra ' +
        'opcionalmente por problema o contest. Para el detalle y el código de una, usa ' +
        'ver_submission.',
      inputSchema: z.object({
        problem_id: z.uuid().optional().describe('UUID del problema para filtrar.'),
        contest_id: z.uuid().optional().describe('UUID del contest para filtrar.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Submissions por página (1 a 50, por defecto 20).'),
        page_token: pageToken,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run('mis_submissions', 'submissions', 'No se encontraron submissions.', async () => {
        const res = await deps.clients.submissions.listSubmissions(
          {
            pageSize: args.page_size ?? 20,
            pageToken: args.page_token ?? '',
            // Siempre el `sub` del token: nunca un user_id que venga en los argumentos.
            userId: caller.sub,
            problemId: args.problem_id,
            contestId: args.contest_id,
          },
          opts(),
        );
        const submissions = res.submissions.map(submissionSummary);
        const lines = submissions.map(
          (s) =>
            `- ${s.submitted_at_text} · ${s.verdict} (${s.verdict_label}) · ` +
            // Sin veredicto final, casos/tiempo/memoria valen 0 y no significan nada.
            (s.judged_at
              ? `${s.passed_cases}/${s.total_cases} casos · ${s.time_ms} ms · ${formatMemory(s.memory_kb)} · `
              : 'sin veredicto final · ') +
            `${s.language} · problema ${s.problem_id}` +
            (s.contest_id ? ` · contest ${s.contest_id}` : '') +
            ` · id ${s.id}`,
        );
        const text = submissions.length
          ? `${submissions.length} submission(s) de ${caller.username}:\n${lines.join('\n')}${nextPageHint(res.nextPageToken)}`
          : `${caller.username} no tiene submissions con esos filtros.`;
        return ok(text, {
          user_id: caller.sub,
          submissions: submissions.map(({ submitted_at_text: _, ...s }) => s),
          next_page_token: res.nextPageToken,
        });
      }),
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'ver_submission',
    {
      title: 'Ver submission',
      description:
        'Muestra el detalle de una submission: veredicto con un resumen (casos pasados de ' +
        'los totales, tiempo y memoria comparados con los límites del problema), lenguaje, ' +
        'fechas y el código fuente si el usuario es su autor. Úsala para explicar por qué ' +
        'una submission dio Wrong Answer, Time Limit Exceeded, Runtime Error, etc.',
      inputSchema: z.object({
        id: z.uuid().describe('UUID de la submission.'),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run('ver_submission', 'submissions', `La submission ${args.id} no existe.`, async () => {
        const res = await deps.clients.submissions.getSubmission({ id: args.id }, opts());
        if (!res.submission) throw new ToolFailure(`La submission ${args.id} no existe.`);
        const s = res.submission;
        // Límites del problema para contextualizar TLE/MLE. Best effort: si problems falla,
        // la tool responde igual sin los límites.
        let problem: Problem | undefined;
        try {
          problem = (
            await deps.clients.problems.getProblem(
              { key: { case: 'id', value: s.problemId } },
              opts(),
            )
          ).problem;
        } catch (err) {
          log.debug({ err, problemId: s.problemId }, 'sin límites del problema para la submission');
        }
        return formatSubmission(s, problem, caller);
      }),
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'ver_scoreboard',
    {
      title: 'Ver scoreboard',
      description:
        'Muestra el scoreboard (tabla de posiciones) de un contest: posición, usuario, ' +
        'problemas resueltos, penalización y el resultado por problema (resuelto, intentos y ' +
        'minuto). Marca la fila del usuario que conversa. Úsala para responder "¿cómo voy en ' +
        'el contest?" o quién va primero.',
      inputSchema: z.object({
        contest_id: z.uuid().describe('UUID del contest.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Filas por página (1 a 100, por defecto 50).'),
        page_token: pageToken,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run('ver_scoreboard', 'ranking', `El contest ${args.contest_id} no existe.`, async () => {
        const res = await deps.clients.ranking.getScoreboard(
          {
            contestId: args.contest_id,
            pageSize: args.page_size ?? 50,
            pageToken: args.page_token ?? '',
          },
          opts(),
        );
        return formatScoreboard(
          args.contest_id,
          res.rows,
          res.nextPageToken,
          res.updatedAt,
          caller,
        );
      }),
  );
}

// -----------------------------------------------------------------------------------------
// Formato de respuestas
// -----------------------------------------------------------------------------------------

function formatProblem(p: Problem): CallToolResult {
  const statement = truncate(p.statement);
  const examples = p.examples.map((e) => ({
    input: truncate(e.input, 1_000).text,
    output: truncate(e.output, 1_000).text,
    explanation: e.explanation,
  }));
  const text = [
    `# ${p.title}`,
    `slug: ${p.slug} · id: ${p.id} · dificultad: ${DIFFICULTY_LABEL[p.difficulty] ?? 'sin dificultad'}` +
      (p.published ? '' : ' · NO publicado'),
    `Límites: ${p.timeLimitMs} ms, ${p.memoryLimitMb} MB · ${p.testcaseCount} casos de prueba`,
    p.tags.length ? `Etiquetas: ${p.tags.join(', ')}` : '',
    '',
    '## Enunciado',
    statement.text + truncationNotice(statement, 'Enunciado'),
    ...examples.flatMap((e, i) => [
      '',
      `## Ejemplo ${i + 1}`,
      `Entrada:\n${e.input}`,
      `Salida:\n${e.output}`,
      e.explanation ? `Explicación: ${e.explanation}` : '',
    ]),
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
    .trimEnd();
  return ok(text, {
    problem: {
      id: p.id,
      slug: p.slug,
      title: p.title,
      difficulty: DIFFICULTY_LABEL[p.difficulty] ?? 'sin dificultad',
      tags: p.tags,
      time_limit_ms: p.timeLimitMs,
      memory_limit_mb: p.memoryLimitMb,
      testcase_count: p.testcaseCount,
      published: p.published,
      statement: statement.text,
      statement_truncated: statement.truncated,
      statement_length: statement.originalLength,
      examples,
    },
  });
}

function submissionSummary(s: Submission) {
  const info = verdictInfo(s.verdict);
  return {
    id: s.id,
    problem_id: s.problemId,
    contest_id: s.contestId ?? null,
    language: LANGUAGE_LABEL[s.language] ?? 'desconocido',
    verdict: info.code,
    verdict_label: info.label,
    passed_cases: s.passedCases,
    total_cases: s.totalCases,
    time_ms: s.timeMs,
    memory_kb: s.memoryKb,
    submitted_at: isoDate(s.submittedAt) ?? null,
    judged_at: isoDate(s.judgedAt) ?? null,
    submitted_at_text: shortDate(s.submittedAt),
  };
}

function formatSubmission(
  s: Submission,
  problem: Problem | undefined,
  caller: Caller,
): CallToolResult {
  const summary = submissionSummary(s);
  const info = verdictInfo(s.verdict);
  const finished = summary.judged_at !== null;
  const timeLimit = problem?.timeLimitMs;
  const memoryLimitKb = problem ? problem.memoryLimitMb * 1024 : undefined;

  const verdictLines = [
    `Veredicto: ${info.code} — ${info.label}. ${info.meaning}`,
    ...(finished
      ? [
          `Casos: pasó ${s.passedCases} de ${s.totalCases}.`,
          `Tiempo: ${s.timeMs} ms${timeLimit ? ` (límite ${timeLimit} ms)` : ''} · ` +
            `Memoria: ${formatMemory(s.memoryKb)}${memoryLimitKb ? ` (límite ${problem!.memoryLimitMb} MB)` : ''}`,
        ]
      : [
          'Todavía no tiene veredicto final: casos, tiempo y memoria aún no se conocen.' +
            (timeLimit
              ? ` Límites del problema: ${timeLimit} ms, ${problem!.memoryLimitMb} MB.`
              : ''),
        ]),
  ];
  const code = truncate(s.sourceCode);
  const isOwnerOrAdmin = s.userId === caller.sub || caller.role === 'ADMIN';
  const codeBlock = s.sourceCode
    ? [
        '',
        `## Código (${summary.language})`,
        '```',
        code.text,
        '```' + truncationNotice(code, 'Código'),
      ]
    : isOwnerOrAdmin
      ? []
      : ['', 'El código fuente no es visible: la submission es de otro usuario.'];

  const text = [
    `# Submission ${s.id}`,
    `Problema: ${problem ? `${problem.title} (${s.problemId})` : s.problemId}` +
      (s.contestId ? ` · contest ${s.contestId}` : ''),
    `Lenguaje: ${summary.language} · enviada ${summary.submitted_at_text}` +
      (finished ? ` · juzgada ${shortDate(s.judgedAt)}` : ''),
    '',
    ...verdictLines,
    ...codeBlock,
  ].join('\n');

  const { submitted_at_text: _, ...data } = summary;
  return ok(text, {
    submission: {
      ...data,
      user_id: s.userId,
      verdict_explanation: info.meaning,
      source_code: code.text,
      source_code_truncated: code.truncated,
    },
    problem: problem
      ? {
          id: problem.id,
          title: problem.title,
          time_limit_ms: problem.timeLimitMs,
          memory_limit_mb: problem.memoryLimitMb,
        }
      : null,
  });
}

function formatScoreboard(
  contestId: string,
  rows: ScoreboardRow[],
  nextPageToken: string,
  updatedAt: Parameters<typeof isoDate>[0],
  caller: Caller,
): CallToolResult {
  // Los problemas son UUIDs: se etiquetan P1, P2… en orden de aparición, con una leyenda.
  const problemIds: string[] = [];
  for (const row of rows) {
    for (const pr of row.problems)
      if (!problemIds.includes(pr.problemId)) problemIds.push(pr.problemId);
  }
  const label = (id: string) => `P${problemIds.indexOf(id) + 1}`;

  const lines = rows.map((row) => {
    const results = row.problems
      .map((pr) =>
        pr.solved
          ? `${label(pr.problemId)}✓ min ${pr.solvedAtMinute} (${pr.attempts} int.)${pr.firstToSolve ? ' 1º' : ''}`
          : pr.attempts > 0
            ? `${label(pr.problemId)}✗ (${pr.attempts} int.)`
            : null,
      )
      .filter(Boolean)
      .join(' · ');
    const you = row.userId === caller.sub ? ' ← tú' : '';
    return `#${row.rank} ${row.username}${you} — ${row.solved} resuelto(s), ${row.penaltyMinutes} min de penalización${results ? ` — ${results}` : ''}`;
  });
  const mine = rows.find((r) => r.userId === caller.sub);
  const text = rows.length
    ? [
        `Scoreboard del contest ${contestId} (actualizado ${shortDate(updatedAt)}):`,
        ...lines,
        problemIds.length
          ? `Problemas: ${problemIds.map((id) => `${label(id)} = ${id}`).join(', ')}`
          : '',
        mine ? '' : `${caller.username} no aparece en esta página del scoreboard.`,
      ]
        .filter(Boolean)
        .join('\n') + nextPageHint(nextPageToken)
    : `El scoreboard del contest ${contestId} todavía no tiene filas.`;

  return ok(text, {
    contest_id: contestId,
    updated_at: isoDate(updatedAt) ?? null,
    my_rank: mine?.rank ?? null,
    rows: rows.map((row) => ({
      rank: row.rank,
      user_id: row.userId,
      username: row.username,
      solved: row.solved,
      penalty_minutes: row.penaltyMinutes,
      is_me: row.userId === caller.sub,
      problems: row.problems.map((pr) => ({
        problem_id: pr.problemId,
        label: label(pr.problemId),
        solved: pr.solved,
        attempts: pr.attempts,
        solved_at_minute: pr.solvedAtMinute,
        penalty_minutes: pr.penaltyMinutes,
        first_to_solve: pr.firstToSolve,
      })),
    })),
    next_page_token: nextPageToken,
  });
}
