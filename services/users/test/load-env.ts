// Setup de `test:int`: carga ../../.env y ../../.env.example sin pisar variables ya
// definidas en el shell (la primera que define una variable gana).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const file of ['../../.env', '../../.env.example']) {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}
