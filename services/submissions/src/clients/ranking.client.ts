import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { RankingService } from '@juez/contracts/es';
import type { Contest } from '@juez/contracts/es';
import type { Logger } from '../logger.js';

export interface RankingClient {
  getContest(contestId: string, authHeader?: string): Promise<Contest>;
}

export class ConnectRankingClient implements RankingClient {
  private client: ReturnType<typeof createClient<typeof RankingService>>;

  constructor(
    rankingGrpcAddr: string,
    private readonly logger: Logger,
  ) {
    const transport = createGrpcTransport({
      baseUrl: `http://${rankingGrpcAddr}`,
    });
    this.client = createClient(RankingService, transport);
  }

  async getContest(contestId: string, authHeader?: string): Promise<Contest> {
    const headers: Record<string, string> = {};
    if (authHeader) {
      headers[AUTH_METADATA_KEY] = authHeader;
    }
    const res = await this.client.getContest({ id: contestId }, { headers });
    if (!res.contest) {
      throw new Error(`Contest ${contestId} no encontrado`);
    }
    return res.contest;
  }
}
