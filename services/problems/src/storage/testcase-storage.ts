import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3Config } from '../config.js';

export interface TestcaseKeys {
  input: string;
  output: string;
}

export interface PresignedPair {
  inputUrl: string;
  outputUrl: string;
  expiresAt: Date;
}

/** Puerto de almacenamiento de casos de prueba (MinIO/S3). */
export interface TestcaseStorage {
  /** URLs PUT firmadas con el endpoint público (las usa el navegador del setter). */
  presignUpload(problemId: string, ordinal: number): Promise<PresignedPair>;
  /** URLs GET firmadas con el endpoint interno (las usa el judge dentro de la red). */
  presignDownload(problemId: string, ordinal: number): Promise<PresignedPair>;
  /** true si existen ambos archivos (input y output) del caso. */
  testcaseExists(problemId: string, ordinal: number): Promise<boolean>;
  putObject(key: string, body: string | Uint8Array, contentType?: string): Promise<void>;
  ensureBucket(): Promise<void>;
  ping(): Promise<void>;
  destroy(): void;
}

/** Ruta de los archivos de un caso: `problems/{problemId}/{ordinal}.in` y `.out`. */
export function testcaseKeys(problemId: string, ordinal: number): TestcaseKeys {
  const base = `problems/${problemId}/${ordinal}`;
  return { input: `${base}.in`, output: `${base}.out` };
}

export function createS3Client(config: S3Config, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
    // Sin checksums opcionales: si no, el SDK agrega x-amz-checksum-* a las URLs PUT
    // prefirmadas y la subida desde el navegador falla (el checksum sería el de un cuerpo vacío).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.name === 'NoSuchBucket' ||
    e.$metadata?.httpStatusCode === 404
  );
}

export interface S3TestcaseStorageOptions {
  /** Cliente con el endpoint interno: operaciones de datos y firma de URLs del judge. */
  internal: S3Client;
  /** Cliente con el endpoint público: solo firma URLs de subida. */
  public: S3Client;
  bucket: string;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
  now?: () => Date;
}

export class S3TestcaseStorage implements TestcaseStorage {
  private readonly now: () => Date;

  constructor(private readonly opts: S3TestcaseStorageOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  static fromConfig(config: S3Config): S3TestcaseStorage {
    return new S3TestcaseStorage({
      internal: createS3Client(config, config.S3_ENDPOINT),
      public: createS3Client(config, config.S3_PUBLIC_ENDPOINT),
      bucket: config.S3_BUCKET_TESTCASES,
      uploadTtlSeconds: config.S3_PRESIGN_TTL_SECONDS,
      downloadTtlSeconds: config.S3_JUDGE_PRESIGN_TTL_SECONDS,
    });
  }

  async presignUpload(problemId: string, ordinal: number): Promise<PresignedPair> {
    const { input, output } = testcaseKeys(problemId, ordinal);
    const expiresIn = this.opts.uploadTtlSeconds;
    const expiresAt = new Date(this.now().getTime() + expiresIn * 1000);
    const sign = (Key: string) =>
      getSignedUrl(this.opts.public, new PutObjectCommand({ Bucket: this.opts.bucket, Key }), {
        expiresIn,
      });
    const [inputUrl, outputUrl] = await Promise.all([sign(input), sign(output)]);
    return { inputUrl, outputUrl, expiresAt };
  }

  async presignDownload(problemId: string, ordinal: number): Promise<PresignedPair> {
    const { input, output } = testcaseKeys(problemId, ordinal);
    const expiresIn = this.opts.downloadTtlSeconds;
    const expiresAt = new Date(this.now().getTime() + expiresIn * 1000);
    const sign = (Key: string) =>
      getSignedUrl(this.opts.internal, new GetObjectCommand({ Bucket: this.opts.bucket, Key }), {
        expiresIn,
      });
    const [inputUrl, outputUrl] = await Promise.all([sign(input), sign(output)]);
    return { inputUrl, outputUrl, expiresAt };
  }

  async testcaseExists(problemId: string, ordinal: number): Promise<boolean> {
    const { input, output } = testcaseKeys(problemId, ordinal);
    const [hasInput, hasOutput] = await Promise.all([
      this.objectExists(input),
      this.objectExists(output),
    ]);
    return hasInput && hasOutput;
  }

  private async objectExists(Key: string): Promise<boolean> {
    try {
      await this.opts.internal.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async putObject(
    Key: string,
    Body: string | Uint8Array,
    ContentType = 'text/plain; charset=utf-8',
  ): Promise<void> {
    await this.opts.internal.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key, Body, ContentType }),
    );
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.ping();
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.opts.internal.send(new CreateBucketCommand({ Bucket: this.opts.bucket }));
    }
  }

  async ping(): Promise<void> {
    await this.opts.internal.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }

  destroy(): void {
    this.opts.internal.destroy();
    this.opts.public.destroy();
  }
}
