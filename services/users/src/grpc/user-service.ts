import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import type { ServiceImpl } from '@connectrpc/connect';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { Role } from '@juez/contracts/es';
import type { UserSchema, UserService } from '@juez/contracts/es';
import { getDummyHash, verifyPassword } from '../auth/password.js';
import { JWT_ALGORITHM } from '../auth/tokens.js';
import type { TokenClaims, TokenService } from '../auth/tokens.js';
import type { RoleName } from '../db/schema.js';
import { registerUser } from '../register.js';
import type { UserRecord, UsersRepository } from '../repository.js';
import { isUuid, MAX_BATCH_IDS } from '../validation.js';
import { authenticate } from './auth.js';

export interface UserServiceDeps {
  repo: UsersRepository;
  tokens: TokenService;
  hash?: (password: string) => Promise<string>;
  verify?: (password: string, hash: string) => Promise<boolean>;
}

const ROLE_TO_PROTO: Record<RoleName, Role> = {
  CONTESTANT: Role.CONTESTANT,
  SETTER: Role.SETTER,
  ADMIN: Role.ADMIN,
};

/**
 * Convierte el registro al mensaje User. El email solo se expone al propio usuario y a
 * ADMIN (en el resto de los casos va vacío).
 */
export function toProtoUser(
  user: UserRecord,
  viewer?: Pick<TokenClaims, 'sub' | 'role'>,
): MessageInitShape<typeof UserSchema> {
  const showEmail = !viewer || viewer.sub === user.id || viewer.role === 'ADMIN';
  return {
    id: user.id,
    username: user.username,
    email: showEmail ? user.email : '',
    role: ROLE_TO_PROTO[user.role],
    createdAt: timestampFromDate(user.createdAt),
  };
}

const INVALID_CREDENTIALS = 'Credenciales inválidas';

export function createUserServiceImpl(deps: UserServiceDeps): ServiceImpl<typeof UserService> {
  const verify = deps.verify ?? verifyPassword;

  return {
    async register(req) {
      const user = await registerUser({ repo: deps.repo, hash: deps.hash }, req);
      return { user: toProtoUser(user) };
    },

    async login(req) {
      const login = req.usernameOrEmail.trim();
      if (!login || !req.password) {
        throw new ConnectError(
          'username_or_email y password son obligatorios',
          Code.InvalidArgument,
        );
      }
      const user = await deps.repo.findByLogin(login);
      // Si no existe, se verifica igual contra un hash fijo para no revelar por tiempo
      // de respuesta qué usuarios existen.
      const ok = await verify(req.password, user?.passwordHash ?? (await getDummyHash()));
      if (!user || !ok) throw new ConnectError(INVALID_CREDENTIALS, Code.Unauthenticated);

      const { token, expiresAt } = await deps.tokens.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
      return {
        accessToken: token,
        tokenType: 'Bearer',
        expiresAt: timestampFromDate(expiresAt),
        user: toProtoUser(user),
      };
    },

    async getUser(req, ctx) {
      const viewer = await authenticate(ctx.requestHeader, deps.tokens);
      if (!isUuid(req.id)) throw new ConnectError('id debe ser un UUID', Code.InvalidArgument);
      const user = await deps.repo.findById(req.id);
      if (!user) throw new ConnectError('Usuario no encontrado', Code.NotFound);
      return { user: toProtoUser(user, viewer) };
    },

    async getUsers(req, ctx) {
      const viewer = await authenticate(ctx.requestHeader, deps.tokens);
      const ids = [...new Set(req.ids)];
      if (ids.length > MAX_BATCH_IDS) {
        throw new ConnectError(`Máximo ${MAX_BATCH_IDS} ids por llamada`, Code.InvalidArgument);
      }
      // Los ids que no son UUID no pueden existir: se omiten como los inexistentes.
      const found = await deps.repo.findByIds(ids.filter(isUuid));
      const byId = new Map(found.map((u) => [u.id, u]));
      const users = ids.flatMap((id) => {
        const u = byId.get(id);
        return u ? [toProtoUser(u, viewer)] : [];
      });
      return { users };
    },

    getPublicKey() {
      return {
        publicKeyPem: deps.tokens.publicKeyPem,
        keyId: deps.tokens.keyId,
        algorithm: JWT_ALGORITHM,
        issuer: deps.tokens.issuer,
        audience: deps.tokens.audience,
      };
    },
  };
}
