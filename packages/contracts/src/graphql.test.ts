import { readFileSync } from 'node:fs';
import {
  assertValidSchema,
  buildSchema,
  GraphQLEnumType,
  GraphQLObjectType,
  isNonNullType,
  parse,
  validateSchema,
} from 'graphql';
import type { GraphQLSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { ContestStatus, Difficulty, Language, Role, Verdict } from './es.js';
import { GRAPHQL_SCHEMA_PATH } from './graphql.js';

const sdl = readFileSync(GRAPHQL_SCHEMA_PATH, 'utf8');
const schema: GraphQLSchema = buildSchema(sdl);

/** Nombres de un enum de protobuf-es sin UNSPECIFIED (los enums TS numéricos tienen mapeo inverso). */
function protoEnumNames(protoEnum: Record<string, string | number>): string[] {
  return Object.keys(protoEnum)
    .filter((key) => Number.isNaN(Number(key)) && key !== 'UNSPECIFIED')
    .sort();
}

function graphqlEnumNames(name: string): string[] {
  const type = schema.getType(name);
  if (!(type instanceof GraphQLEnumType)) throw new Error(`${name} no es un enum`);
  return type
    .getValues()
    .map((value) => value.name)
    .sort();
}

function rootFields(type: GraphQLObjectType | null | undefined) {
  if (!type) throw new Error('falta el tipo raíz');
  return type.getFields();
}

describe('schema GraphQL', () => {
  it('GRAPHQL_SCHEMA_PATH apunta a un archivo que parsea y es un schema válido', () => {
    expect(GRAPHQL_SCHEMA_PATH.endsWith('graphql/schema.graphql')).toBe(true);
    expect(() => parse(sdl)).not.toThrow();
    expect(validateSchema(schema)).toEqual([]);
    expect(() => assertValidSchema(schema)).not.toThrow();
  });

  it('cubre las operaciones de todos los servicios', () => {
    expect(Object.keys(rootFields(schema.getQueryType())).sort()).toEqual(
      [
        'contest',
        'contests',
        'me',
        'problem',
        'problems',
        'scoreboard',
        'submission',
        'submissions',
        'user',
        'userStats',
      ].sort(),
    );
    expect(Object.keys(rootFields(schema.getMutationType())).sort()).toEqual(
      [
        'askAssistant',
        'createContest',
        'createProblem',
        'createTestcaseUploadUrl',
        'login',
        'register',
        'submit',
        'updateProblem',
      ].sort(),
    );
    expect(Object.keys(rootFields(schema.getSubscriptionType())).sort()).toEqual([
      'scoreboardUpdated',
      'submissionUpdated',
    ]);
  });

  it('cada operación documenta quién puede usarla', () => {
    const roots = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()];
    for (const root of roots) {
      for (const field of Object.values(rootFields(root))) {
        expect(field.description, `${root?.name}.${field.name}`).toMatch(/\*\*Acceso:\*\* \S/);
      }
    }
  });

  it('los enums son equivalentes a los del proto (sin UNSPECIFIED)', () => {
    expect(graphqlEnumNames('Role')).toEqual(protoEnumNames(Role));
    expect(graphqlEnumNames('Language')).toEqual(protoEnumNames(Language));
    expect(graphqlEnumNames('Verdict')).toEqual(protoEnumNames(Verdict));
    expect(graphqlEnumNames('Difficulty')).toEqual(protoEnumNames(Difficulty));
    expect(graphqlEnumNames('ContestStatus')).toEqual(protoEnumNames(ContestStatus));
  });

  it('los listados paginan con items + nextPageToken', () => {
    for (const name of ['ProblemPage', 'SubmissionPage', 'ContestPage', 'Scoreboard']) {
      const type = schema.getType(name);
      expect(type, name).toBeInstanceOf(GraphQLObjectType);
      const fields = (type as GraphQLObjectType).getFields();
      expect(fields.items && isNonNullType(fields.items.type), `${name}.items`).toBe(true);
      expect(fields.nextPageToken?.type.toString(), `${name}.nextPageToken`).toBe('String');
    }
    const listQueries = ['problems', 'submissions', 'contests', 'scoreboard'];
    const queryFields = rootFields(schema.getQueryType());
    for (const name of listQueries) {
      const args = queryFields[name]?.args.map((arg) => arg.name) ?? [];
      expect(args, name).toEqual(expect.arrayContaining(['pageSize', 'pageToken']));
    }
  });

  it('las fechas usan el escalar DateTime', () => {
    expect(schema.getType('DateTime')?.toString()).toBe('DateTime');
    const dateFields: [string, string][] = [
      ['User', 'createdAt'],
      ['AuthPayload', 'expiresAt'],
      ['Problem', 'createdAt'],
      ['Submission', 'submittedAt'],
      ['Submission', 'judgedAt'],
      ['Contest', 'startTime'],
      ['Contest', 'endTime'],
      ['TestcaseUpload', 'expiresAt'],
    ];
    for (const [typeName, fieldName] of dateFields) {
      const type = schema.getType(typeName) as GraphQLObjectType;
      const fieldType = type.getFields()[fieldName]?.type.toString();
      expect(fieldType?.replace('!', ''), `${typeName}.${fieldName}`).toBe('DateTime');
    }
  });
});
