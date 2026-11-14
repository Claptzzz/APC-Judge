import { join } from 'node:path';
import { Language } from '@juez/contracts/es';

export interface CommandLine {
  command: string;
  args: string[];
}

export interface LanguageSpec {
  /** Nombre del archivo fuente dentro del directorio de trabajo. */
  sourceFile: string;
  /** Compilación (C++) o validación de sintaxis (Python). */
  compile(dir: string): CommandLine;
  run(dir: string): CommandLine;
}

export const LANGUAGES: Partial<Record<Language, LanguageSpec>> = {
  [Language.CPP17]: {
    sourceFile: 'main.cpp',
    compile: () => ({ command: 'g++', args: ['-O2', '-std=gnu++17', '-o', 'main', 'main.cpp'] }),
    run: (dir) => ({ command: join(dir, 'main'), args: [] }),
  },
  [Language.PYTHON3]: {
    sourceFile: 'main.py',
    // Python no se compila: solo se valida la sintaxis.
    compile: () => ({ command: 'python3', args: ['-m', 'py_compile', 'main.py'] }),
    run: () => ({ command: 'python3', args: ['main.py'] }),
  },
};

export function languageSpec(language: Language): LanguageSpec | undefined {
  return LANGUAGES[language];
}
