import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { depthLimitRule } from './depth-limit.js';

const schema = buildSchema(`
  type Node { id: ID! child: Node }
  type Query { node: Node }
`);

const errors = (query: string, max: number) =>
  validate(schema, parse(query), [depthLimitRule(max)]).map((e) => e.message);

describe('depthLimitRule', () => {
  it('cuenta campos anidados', () => {
    expect(errors('{ node { child { id } } }', 3)).toEqual([]);
    expect(errors('query Q { node { child { child { id } } } }', 3)).toEqual([
      'La operación Q tiene profundidad 4; el máximo es 3.',
    ]);
  });

  it('sigue fragmentos e inline fragments, sin ciclos infinitos', () => {
    const q = `
      query { node { ...F } }
      fragment F on Node { child { ... on Node { child { id } } } }
    `;
    expect(errors(q, 4)).toEqual([]);
    expect(errors(q, 3)).toHaveLength(1);
    // Fragmento inexistente o cíclico: lo reportan otras reglas, aquí no revienta.
    expect(() => errors('{ node { ...Nope } }', 3)).not.toThrow();
    const cyclic = `query { node { ...A } } fragment A on Node { child { ...A } }`;
    expect(() => errors(cyclic, 3)).not.toThrow();
  });

  it('ignora la introspección', () => {
    expect(
      errors('{ __schema { types { fields { type { ofType { ofType { name } } } } } } }', 2),
    ).toEqual([]);
  });
});
