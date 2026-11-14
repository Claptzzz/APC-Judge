import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { S3Config } from '../config.js';
import { createS3Client, S3TestcaseStorage, testcaseKeys } from './testcase-storage.js';

const config: S3Config = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: true,
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET_TESTCASES: 'testcases',
  S3_PRESIGN_TTL_SECONDS: 900,
  S3_JUDGE_PRESIGN_TTL_SECONDS: 600,
};

const PROBLEM = '10000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-11T10:00:00Z');

function storageWith(send: (cmd: unknown) => Promise<unknown>) {
  const internal = createS3Client(config, config.S3_ENDPOINT);
  const pub = createS3Client(config, config.S3_PUBLIC_ENDPOINT);
  const spy = vi.spyOn(internal, 'send').mockImplementation(send as S3Client['send']);
  const storage = new S3TestcaseStorage({
    internal,
    public: pub,
    bucket: 'testcases',
    uploadTtlSeconds: 900,
    downloadTtlSeconds: 600,
    now: () => NOW,
  });
  return { storage, spy };
}

const notFound = () =>
  Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

describe('testcaseKeys', () => {
  it('usa problems/{id}/{n}.in y .out', () => {
    expect(testcaseKeys(PROBLEM, 3)).toEqual({
      input: `problems/${PROBLEM}/3.in`,
      output: `problems/${PROBLEM}/3.out`,
    });
  });
});

describe('S3TestcaseStorage', () => {
  it('firma las URLs de subida con el endpoint público (PUT, TTL de subida)', async () => {
    const storage = S3TestcaseStorage.fromConfig(config);
    const urls = await storage.presignUpload(PROBLEM, 1);
    const input = new URL(urls.inputUrl);
    expect(input.origin).toBe('http://localhost:9000');
    expect(input.pathname).toBe(`/testcases/problems/${PROBLEM}/1.in`);
    expect(input.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(input.searchParams.get('x-id')).toBe('PutObject');
    expect(input.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    // Sin checksums: el navegador no podría reproducirlos.
    expect(urls.inputUrl).not.toMatch(/checksum/i);
    expect(new URL(urls.outputUrl).pathname).toBe(`/testcases/problems/${PROBLEM}/1.out`);
    storage.destroy();
  });

  it('firma las URLs del judge con el endpoint interno (GET, TTL corto)', async () => {
    const { storage } = storageWith(() => Promise.resolve({}));
    const urls = await storage.presignDownload(PROBLEM, 2);
    const output = new URL(urls.outputUrl);
    expect(output.origin).toBe('http://minio:9000');
    expect(output.pathname).toBe(`/testcases/problems/${PROBLEM}/2.out`);
    expect(output.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(output.searchParams.get('x-id')).toBe('GetObject');
    expect(urls.expiresAt).toEqual(new Date(NOW.getTime() + 600_000));
  });

  it('testcaseExists exige input y output', async () => {
    const present = new Set([
      `problems/${PROBLEM}/1.in`,
      `problems/${PROBLEM}/1.out`,
      `problems/${PROBLEM}/2.in`,
    ]);
    const { storage, spy } = storageWith((cmd) => {
      const key = (cmd as HeadObjectCommand).input.Key!;
      return present.has(key) ? Promise.resolve({}) : Promise.reject(notFound());
    });
    expect(await storage.testcaseExists(PROBLEM, 1)).toBe(true);
    expect(await storage.testcaseExists(PROBLEM, 2)).toBe(false);
    expect(spy.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('testcaseExists propaga errores que no son 404', async () => {
    const { storage } = storageWith(() => Promise.reject(new Error('timeout')));
    await expect(storage.testcaseExists(PROBLEM, 1)).rejects.toThrow('timeout');
  });

  it('putObject, ping y ensureBucket', async () => {
    let bucketExists = false;
    const { storage, spy } = storageWith((cmd) => {
      if (cmd instanceof HeadBucketCommand)
        return bucketExists ? Promise.resolve({}) : Promise.reject(notFound());
      return Promise.resolve({});
    });
    await storage.putObject('k', 'v');
    expect(spy.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    await storage.ensureBucket();
    expect(spy.mock.calls.some(([c]) => c instanceof CreateBucketCommand)).toBe(true);
    bucketExists = true;
    spy.mockClear();
    await storage.ensureBucket();
    expect(spy.mock.calls.some(([c]) => c instanceof CreateBucketCommand)).toBe(false);
  });

  it('ensureBucket propaga errores distintos de 404', async () => {
    const { storage } = storageWith(() => Promise.reject(new Error('403')));
    await expect(storage.ensureBucket()).rejects.toThrow('403');
  });
});
