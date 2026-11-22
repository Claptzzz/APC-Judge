import { describe, expect, it, vi } from 'vitest';
import { pairTestcaseFiles, uploadToPresignedUrl } from './testcases';

const file = (name: string) => new File(['x'], name);

describe('pairTestcaseFiles', () => {
  it('empareja .in con .out/.ans en orden natural', () => {
    const { pairs, unmatched } = pairTestcaseFiles([
      file('10.in'),
      file('2.in'),
      file('2.out'),
      file('10.ans'),
      file('3.in'),
      file('4.out'),
      file('notas.txt'),
    ]);
    expect(pairs.map((p) => [p.name, p.input.name, p.output.name])).toEqual([
      ['2', '2.in', '2.out'],
      ['10', '10.in', '10.ans'],
    ]);
    expect(unmatched.sort()).toEqual(['3.in', '4.out', 'notas.txt']);
  });
});

describe('uploadToPresignedUrl', () => {
  it('hace PUT con el archivo como cuerpo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const f = file('1.in');
    await uploadToPresignedUrl('http://minio/x?sig=1', f, fetchMock);
    expect(fetchMock).toHaveBeenCalledWith('http://minio/x?sig=1', { method: 'PUT', body: f });
  });

  it('falla si MinIO responde con error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(uploadToPresignedUrl('http://minio/x', file('1.in'), fetchMock)).rejects.toThrow(
      'HTTP 403',
    );
  });
});
