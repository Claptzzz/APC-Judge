import { GraphQLError, Kind } from 'graphql';
import type {
  ASTVisitor,
  FragmentDefinitionNode,
  SelectionSetNode,
  ValidationContext,
  ValidationRule,
} from 'graphql';

/**
 * Regla de validación que rechaza operaciones con selecciones anidadas a más de `maxDepth`
 * niveles (sigue fragmentos; ignora los campos de introspección `__*`).
 */
export function depthLimitRule(maxDepth: number): ValidationRule {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    }

    const depthOf = (set: SelectionSetNode | undefined, visited: Set<string>): number => {
      if (!set) return 0;
      let max = 0;
      for (const sel of set.selections) {
        let d: number;
        if (sel.kind === Kind.FIELD) {
          if (sel.name.value.startsWith('__')) continue;
          d = sel.selectionSet ? 1 + depthOf(sel.selectionSet, visited) : 1;
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          d = depthOf(sel.selectionSet, visited);
        } else {
          const name = sel.name.value;
          const frag = fragments.get(name);
          if (!frag || visited.has(name)) continue; // ciclos: los reporta otra regla
          d = depthOf(frag.selectionSet, new Set(visited).add(name));
        }
        if (d > max) max = d;
      }
      return max;
    };

    return {
      OperationDefinition(node) {
        const depth = depthOf(node.selectionSet, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `La operación ${node.name?.value ?? '(anónima)'} tiene profundidad ${depth}; el máximo es ${maxDepth}.`,
              { nodes: [node], extensions: { code: 'BAD_USER_INPUT' } },
            ),
          );
        }
      },
    };
  };
}
