import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as es from './es.js';
import * as root from './index.js';
import * as nest from './nest.js';

describe('subpaths', () => {
  it('./es expone schemas, enums y servicios', () => {
    expect(es.UserService.typeName).toBe('juez.users.v1.UserService');
    expect(es.ProblemService.typeName).toBe('juez.problems.v1.ProblemService');
    expect(es.SubmissionService.typeName).toBe('juez.submissions.v1.SubmissionService');
    expect(es.RankingService.typeName).toBe('juez.ranking.v1.RankingService');
    expect(es.SubmissionJudgedSchema.typeName).toBe('juez.events.v1.SubmissionJudged');
    expect(es.Verdict.ACCEPTED).toBe(3);
    expect(es.Language.UNSPECIFIED).toBe(0);
  });

  it('./nest expone constantes de paquete y servicio por namespace', () => {
    expect(nest.users.JUEZ_USERS_V1_PACKAGE_NAME).toBe('juez.users.v1');
    expect(nest.users.USER_SERVICE_NAME).toBe('UserService');
    expect(nest.problems.PROBLEM_SERVICE_NAME).toBe('ProblemService');
    expect(nest.submissions.SUBMISSION_SERVICE_NAME).toBe('SubmissionService');
    expect(nest.ranking.RANKING_SERVICE_NAME).toBe('RankingService');
    expect(nest.common.Verdict.VERDICT_ACCEPTED).toBe(3);
    expect(typeof nest.submissions.SubmissionServiceControllerMethods).toBe('function');
  });

  it('. expone topics, helpers y la key de metadata del JWT', () => {
    expect(root.AUTH_METADATA_KEY).toBe('authorization');
    expect(typeof root.encodeEvent).toBe('function');
    expect(typeof root.decodeEvent).toBe('function');
  });
});
