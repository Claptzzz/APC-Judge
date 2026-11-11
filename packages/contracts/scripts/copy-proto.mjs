// Copia los .proto fuente (../../proto/juez) dentro del paquete, para que el subpath
// `@juez/contracts/proto` los resuelva también en imágenes Docker (pnpm deploy).
import { cpSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../../proto/juez', import.meta.url));
const dest = fileURLToPath(new URL('../proto/juez', import.meta.url));

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, {
  recursive: true,
  filter: (p) => statSync(p).isDirectory() || p.endsWith('.proto'),
});
console.log(`proto copiados a ${dest}`);
