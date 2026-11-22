export interface TestcasePair {
  name: string;
  input: File;
  output: File;
}

const INPUT_EXT = ['in', 'input'];
const OUTPUT_EXT = ['out', 'output', 'ans', 'answer'];

function split(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

/**
 * Empareja archivos `<nombre>.in` con `<nombre>.out` (o `.ans`). Devuelve los pares en orden
 * natural (`2` antes que `10`) y los nombres de los archivos que quedaron sin pareja.
 */
export function pairTestcaseFiles(files: File[]): { pairs: TestcasePair[]; unmatched: string[] } {
  const inputs = new Map<string, File>();
  const outputs = new Map<string, File>();
  const unmatched: string[] = [];
  for (const file of files) {
    const { stem, ext } = split(file.name);
    if (INPUT_EXT.includes(ext)) inputs.set(stem, file);
    else if (OUTPUT_EXT.includes(ext)) outputs.set(stem, file);
    else unmatched.push(file.name);
  }
  const pairs: TestcasePair[] = [];
  for (const [stem, input] of inputs) {
    const output = outputs.get(stem);
    if (output) {
      pairs.push({ name: stem, input, output });
      outputs.delete(stem);
    } else unmatched.push(input.name);
  }
  for (const output of outputs.values()) unmatched.push(output.name);
  pairs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { pairs, unmatched };
}

/** Sube un archivo con `HTTP PUT` directo a la URL prefirmada de MinIO. */
export async function uploadToPresignedUrl(
  url: string,
  file: Blob,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(url, { method: 'PUT', body: file });
  if (!response.ok) throw new Error(`La subida falló (HTTP ${response.status})`);
}
