import type { Language } from '../gen/graphql';

export const TEMPLATES: Record<Language, string> = {
  CPP17: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    return 0;
}
`,
  PYTHON3: `import sys


def main():
    data = sys.stdin.read().split()


if __name__ == "__main__":
    main()
`,
};

const key = (problemId: string, language: Language) => `juez.draft.${problemId}.${language}`;

/** Borrador guardado del código (por problema y lenguaje) o la plantilla. */
export function loadDraft(problemId: string, language: Language): string {
  try {
    return localStorage.getItem(key(problemId, language)) ?? TEMPLATES[language];
  } catch {
    return TEMPLATES[language];
  }
}

export function saveDraft(problemId: string, language: Language, code: string): void {
  try {
    if (code === TEMPLATES[language]) localStorage.removeItem(key(problemId, language));
    else localStorage.setItem(key(problemId, language), code);
  } catch {
    // Sin localStorage el borrador simplemente no se guarda.
  }
}
