import { randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type {
  CreateProblemRequest,
  CreateTestcaseUploadUrlRequest,
  GetProblemRequest,
  ListProblemsRequest,
  UpdateProblemRequest,
} from '@juez/contracts/es';
import type { Principal } from '../auth/jwt.js';
import {
  SlugTakenError,
  type ProblemRecord,
  type ProblemsRepository,
  type TestcaseRecord,
} from '../db/problems-repository.js';
import type { Logger } from '../logger.js';
import type { TestcaseStorage } from '../storage/testcase-storage.js';
import { slugCandidate, slugify } from './slug.js';
import {
  decodePageToken,
  difficultyToDb,
  encodePageToken,
  normalizeTags,
  pageSize,
  requireUuid,
  validateCreate,
  validateOrdinal,
  validateUpdate,
} from './validation.js';

export interface ProblemView {
  problem: ProblemRecord;
  /** Casos con input y output confirmados en S3. */
  testcaseCount: number;
}

export interface JudgeSpec {
  problem: ProblemRecord;
  testcases: Array<{ id: string; ordinal: number; inputUrl: string; outputUrl: string }>;
  urlsExpireAt: Date;
}

export interface UploadUrls {
  testcaseId: string;
  inputUrl: string;
  outputUrl: string;
  expiresAt: Date;
}

const SLUG_ATTEMPTS = 20;

const notFound = (): ConnectError => new ConnectError('problema no encontrado', Code.NotFound);
const unauthenticated = (): ConnectError =>
  new ConnectError('se requiere autenticación', Code.Unauthenticated);

const canManageProblems = (p: Principal | undefined): boolean =>
  p?.role === 'SETTER' || p?.role === 'ADMIN';

/** Solo SETTER/ADMIN ven problemas sin publicar; anónimos y CONTESTANT ven los publicados. */
const canSeeUnpublished = canManageProblems;

function requireSetter(principal: Principal | undefined): Principal {
  if (!principal) throw unauthenticated();
  if (!canManageProblems(principal)) {
    throw new ConnectError('se requiere rol SETTER o ADMIN', Code.PermissionDenied);
  }
  return principal;
}

function requireAuthorOrAdmin(principal: Principal, problem: ProblemRecord): void {
  if (principal.role !== 'ADMIN' && principal.userId !== problem.authorId) {
    throw new ConnectError(
      'solo el autor del problema o un ADMIN puede modificarlo',
      Code.PermissionDenied,
    );
  }
}

export interface ProblemCatalogDeps {
  repo: ProblemsRepository;
  storage: TestcaseStorage;
  logger: Logger;
  now?: () => Date;
  newId?: () => string;
}

/** Casos de uso del catálogo. Las reglas de autorización viven aquí, no en el transporte. */
export class ProblemCatalog {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: ProblemCatalogDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  async list(
    req: ListProblemsRequest,
    principal: Principal | undefined,
  ): Promise<{ problems: ProblemRecord[]; nextPageToken: string }> {
    const limit = pageSize(req.pageSize);
    const rows = await this.deps.repo.list({
      tags: normalizeTags(req.tags),
      difficulty: difficultyToDb(req.difficulty),
      publishedOnly: !canSeeUnpublished(principal),
      afterSeq: decodePageToken(req.pageToken),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      problems: page,
      nextPageToken: rows.length > limit && last ? encodePageToken(last.seq) : '',
    };
  }

  async get(req: GetProblemRequest, principal: Principal | undefined): Promise<ProblemView> {
    let problem: ProblemRecord | undefined;
    switch (req.key.case) {
      case 'id':
        problem = await this.deps.repo.findById(requireUuid(req.key.value, 'id'));
        break;
      case 'slug':
        problem = await this.deps.repo.findBySlug(req.key.value.trim());
        break;
      default:
        throw new ConnectError('se requiere id o slug', Code.InvalidArgument);
    }
    if (!problem || (!problem.published && !canSeeUnpublished(principal))) throw notFound();
    return this.view(problem);
  }

  async create(req: CreateProblemRequest, principal: Principal | undefined): Promise<ProblemView> {
    const author = requireSetter(principal);
    const { slug: requested, ...fields } = validateCreate(req);
    const base = requested ?? slugify(fields.title);
    for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
      const slug = requested ?? slugCandidate(base, attempt);
      try {
        const problem = await this.deps.repo.insert({
          ...fields,
          id: this.newId(),
          slug,
          authorId: author.userId,
        });
        this.deps.logger.info(
          { problemId: problem.id, slug, authorId: author.userId },
          'problema creado',
        );
        return { problem, testcaseCount: 0 };
      } catch (err) {
        if (!(err instanceof SlugTakenError)) throw err;
        if (requested) throw new ConnectError(`el slug "${slug}" ya existe`, Code.AlreadyExists);
      }
    }
    throw new ConnectError(
      `no se encontró un slug libre para "${base}"; indica uno explícito`,
      Code.AlreadyExists,
    );
  }

  async update(req: UpdateProblemRequest, principal: Principal | undefined): Promise<ProblemView> {
    const user = requireSetter(principal);
    const id = requireUuid(req.id, 'id');
    const patch = validateUpdate(req);
    const current = await this.deps.repo.findById(id);
    if (!current) throw notFound();
    requireAuthorOrAdmin(user, current);
    const updated =
      Object.keys(patch).length === 0 ? current : await this.deps.repo.update(id, patch);
    if (!updated) throw notFound();
    this.deps.logger.info(
      { problemId: id, fields: Object.keys(patch), userId: user.userId },
      'problema actualizado',
    );
    return this.view(updated);
  }

  async createTestcaseUploadUrl(
    req: CreateTestcaseUploadUrlRequest,
    principal: Principal | undefined,
  ): Promise<UploadUrls> {
    const user = requireSetter(principal);
    const problemId = requireUuid(req.problemId, 'problem_id');
    const ordinal = validateOrdinal(req.ordinal);
    const problem = await this.deps.repo.findById(problemId);
    if (!problem) throw notFound();
    requireAuthorOrAdmin(user, problem);
    const testcase = await this.deps.repo.upsertTestcase({ id: this.newId(), problemId, ordinal });
    const urls = await this.deps.storage.presignUpload(problemId, ordinal);
    this.deps.logger.info(
      { problemId, ordinal, testcaseId: testcase.id },
      'URLs de subida emitidas',
    );
    return {
      testcaseId: testcase.id,
      inputUrl: urls.inputUrl,
      outputUrl: urls.outputUrl,
      expiresAt: urls.expiresAt,
    };
  }

  /** Uso interno del judge: sin JWT (restringido por red). */
  async judgeSpec(problemIdRaw: string): Promise<JudgeSpec> {
    const problemId = requireUuid(problemIdRaw, 'problem_id');
    const problem = await this.deps.repo.findById(problemId);
    if (!problem) throw notFound();
    const ready = (await this.syncUploads(problemId, { strict: true })).filter(
      (t) => t.uploadedAt !== null,
    );
    if (ready.length === 0) {
      throw new ConnectError(
        'el problema no tiene casos de prueba subidos',
        Code.FailedPrecondition,
      );
    }
    const signed = await Promise.all(
      ready.map((t) => this.deps.storage.presignDownload(problemId, t.ordinal)),
    );
    const testcases = ready.map((t, i) => ({
      id: t.id,
      ordinal: t.ordinal,
      inputUrl: signed[i]!.inputUrl,
      outputUrl: signed[i]!.outputUrl,
    }));
    const urlsExpireAt = signed.reduce(
      (min, s) => (s.expiresAt < min ? s.expiresAt : min),
      signed[0]!.expiresAt,
    );
    return { problem, testcases, urlsExpireAt };
  }

  private async view(problem: ProblemRecord): Promise<ProblemView> {
    const testcases = await this.syncUploads(problem.id, { strict: false });
    return { problem, testcaseCount: testcases.filter((t) => t.uploadedAt !== null).length };
  }

  /**
   * El navegador sube directo a S3, así que problems no se entera de la subida. Los casos
   * pendientes se confirman de forma perezosa: si existen input y output, se marcan subidos.
   * Con `strict: false` (lecturas públicas) un fallo de S3 se registra y no corta la respuesta.
   */
  private async syncUploads(
    problemId: string,
    { strict }: { strict: boolean },
  ): Promise<TestcaseRecord[]> {
    const testcases = await this.deps.repo.listTestcases(problemId);
    const pending = testcases.filter((t) => t.uploadedAt === null);
    if (pending.length === 0) return testcases;
    let found: TestcaseRecord[];
    try {
      const exists = await Promise.all(
        pending.map((t) => this.deps.storage.testcaseExists(problemId, t.ordinal)),
      );
      found = pending.filter((_, i) => exists[i]);
    } catch (err) {
      if (strict)
        throw new ConnectError(
          'almacenamiento de casos no disponible',
          Code.Unavailable,
          undefined,
          undefined,
          err,
        );
      this.deps.logger.warn({ err, problemId }, 'no se pudo verificar la subida de casos en S3');
      return testcases;
    }
    if (found.length === 0) return testcases;
    const at = this.now();
    await this.deps.repo.markTestcasesUploaded(
      found.map((t) => t.id),
      at,
    );
    const ids = new Set(found.map((t) => t.id));
    return testcases.map((t) => (ids.has(t.id) ? { ...t, uploadedAt: at } : t));
  }
}
