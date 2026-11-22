import { randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { AuthPayload, LoginInput, RegisterInput, User } from '../../gen/graphql.js';
import type { Backend, CallMeta } from '../../grpc/backend.js';
import { ErrorCode, gqlError, isNotFound } from '../../grpc/errors.js';
import { BACKEND } from '../../tokens.js';
import { optionalUser, requireUser } from '../context.js';
import type { GqlContext } from '../context.js';
import { mapLogin, mapUser } from '../mappers.js';

/** Las RPC públicas (Register, Login) van sin token: solo con x-request-id. */
const publicMeta = (ctx: GqlContext): CallMeta => ({ requestId: ctx.requestId ?? randomUUID() });

@Resolver()
export class UsersResolver {
  constructor(@Inject(BACKEND) private readonly backend: Backend) {}

  @Query('me')
  async me(@Context() ctx: GqlContext): Promise<User> {
    const viewer = requireUser(ctx);
    const res = await this.backend.users.getUser({ id: viewer.sub }, ctx.meta);
    if (!res.user) throw gqlError(ErrorCode.NOT_FOUND, 'El usuario de la sesión ya no existe.');
    return mapUser(res.user, viewer);
  }

  @Query('user')
  async user(@Args('id') id: string, @Context() ctx: GqlContext): Promise<User | null> {
    const viewer = requireUser(ctx);
    try {
      const res = await this.backend.users.getUser({ id }, ctx.meta);
      return res.user ? mapUser(res.user, viewer) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Register y después Login con las mismas credenciales (la ficha: register devuelve token). */
  @Mutation('register')
  async register(
    @Args('input') input: RegisterInput,
    @Context() ctx: GqlContext,
  ): Promise<AuthPayload> {
    optionalUser(ctx);
    const meta = publicMeta(ctx);
    await this.backend.users.register(
      { username: input.username, email: input.email, password: input.password },
      meta,
    );
    const login = await this.backend.users.login(
      { usernameOrEmail: input.username, password: input.password },
      meta,
    );
    return mapLogin(login);
  }

  @Mutation('login')
  async login(@Args('input') input: LoginInput, @Context() ctx: GqlContext): Promise<AuthPayload> {
    optionalUser(ctx);
    const res = await this.backend.users.login(
      { usernameOrEmail: input.usernameOrEmail, password: input.password },
      publicMeta(ctx),
    );
    return mapLogin(res);
  }
}
