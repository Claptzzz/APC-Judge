import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { ProblemService } from '@juez/contracts/es';
import type { Problem } from '@juez/contracts/es';
import type { Logger } from '../logger.js';

export interface ProblemsClient {
  getProblem(problemId: string, authHeader?: string): Promise<Problem>;
}

export class ConnectProblemsClient implements ProblemsClient {
  private client: ReturnType<typeof createClient<typeof ProblemService>>;

  constructor(
    problemsGrpcAddr: string,
    private readonly logger: Logger,
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
      { headers },
    );
    if (!res.problem) {
      throw new Error(`Problema ${problemId} no encontrado`);
    }
    return res.problem;
  }
}
