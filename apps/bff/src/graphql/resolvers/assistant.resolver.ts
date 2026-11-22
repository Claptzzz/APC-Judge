import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import type { AssistantService } from '../../assistant/assistant.service.js';
import type { AssistantAnswer, AssistantMessageInput } from '../../gen/graphql.js';
import { ASSISTANT } from '../../tokens.js';
import { requireUser } from '../context.js';
import type { GqlContext } from '../context.js';

@Resolver()
export class AssistantResolver {
  constructor(@Inject(ASSISTANT) private readonly assistant: Pick<AssistantService, 'ask'>) {}

  @Mutation('askAssistant')
  async askAssistant(
    @Args('message') message: string,
    @Args('history') history: AssistantMessageInput[] | null | undefined,
    @Context() ctx: GqlContext,
  ): Promise<AssistantAnswer> {
    const user = requireUser(ctx);
    return this.assistant.ask({
      userId: user.sub,
      // requireUser garantiza que hay token verificado en la metadata.
      token: ctx.meta.token!,
      requestId: ctx.requestId,
      message,
      history: history ?? [],
    });
  }
}
