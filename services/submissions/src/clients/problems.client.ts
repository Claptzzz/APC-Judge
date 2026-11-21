import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { ProblemService } from '@juez/contracts/es';
import type { Problem } from '@juez/contracts/es';
import type { Logger } from '../logger.js';
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from './errors.js';

export interface ProblemsClient {
  getProblem(problemId: string, authHeader?: string): Promise<Problem>;
}

export class ConnectProblemsClient implements ProblemsClient {
  private client: ReturnType<typeof createClient<typeof ProblemService>>;

  constructor(
    problemsGrpcAddr: string,
    private readonly logger: Logger,
    private readonly timeoutMs: number = DEFAULT_UPSTREAM_TIMEOUT_MS,
  ) {
    const transport = createGrpcTransport({
      baseUrl: `http://${problemsGrpcAddr}`,
    });
    this.client = createClient(ProblemService, transport);
  }

  async getProblem(problemId: string, authHeader?: string): Promise<Problem> {
    const headers: Record<string, string> = {};
    if (authHeader) {
      headers[AUTH_METADATA_KEY] = authHeader;
    }
    const res = await this.client.getProblem(
      { key: { case: 'id', value: problemId } },
      { headers, timeoutMs: this.timeoutMs },
    );
    if (!res.problem) {
      throw new ConnectError(`Problema ${problemId} no encontrado`, Code.NotFound);
    }
    return res.problem;
  }
}
