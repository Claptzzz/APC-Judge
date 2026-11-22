import { graphql } from '../gen';

// Todas las operaciones del front. `pnpm generate` las tipa contra el schema del contrato.

export const ME = graphql(`
  query Me {
    me {
      id
      username
      email
      role
      createdAt
    }
  }
`);

export const LOGIN = graphql(`
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      token
      expiresAt
      user {
        id
        username
        email
        role
      }
    }
  }
`);

export const REGISTER = graphql(`
  mutation Register($input: RegisterInput!) {
    register(input: $input) {
      token
      expiresAt
      user {
        id
        username
        email
        role
      }
    }
  }
`);

export const PROBLEMS = graphql(`
  query Problems($filter: ProblemFilter, $pageSize: Int, $pageToken: String) {
    problems(filter: $filter, pageSize: $pageSize, pageToken: $pageToken) {
      items {
        id
        slug
        title
        difficulty
        tags
        published
      }
      nextPageToken
    }
  }
`);

export const PROBLEM_FIELDS = graphql(`
  fragment ProblemFields on Problem {
    id
    slug
    title
    statement
    difficulty
    tags
    timeLimitMs
    memoryLimitMb
    examples {
      input
      output
      explanation
    }
    testcaseCount
    published
    authorId
    createdAt
    updatedAt
  }
`);

export const PROBLEM = graphql(`
  query Problem($slug: String!) {
    problem(slug: $slug) {
      ...ProblemFields
    }
  }
`);

export const CREATE_PROBLEM = graphql(`
  mutation CreateProblem($input: CreateProblemInput!) {
    createProblem(input: $input) {
      ...ProblemFields
    }
  }
`);

export const UPDATE_PROBLEM = graphql(`
  mutation UpdateProblem($id: ID!, $input: UpdateProblemInput!) {
    updateProblem(id: $id, input: $input) {
      ...ProblemFields
    }
  }
`);

export const CREATE_TESTCASE_UPLOAD = graphql(`
  mutation CreateTestcaseUploadUrl($problemId: ID!, $ordinal: Int!) {
    createTestcaseUploadUrl(problemId: $problemId, ordinal: $ordinal) {
      testcaseId
      ordinal
      inputUploadUrl
      outputUploadUrl
      expiresAt
    }
  }
`);

export const SUBMISSION_VERDICT_FIELDS = graphql(`
  fragment SubmissionVerdictFields on Submission {
    id
    verdict
    timeMs
    memoryKb
    passedCases
    totalCases
    judgedAt
  }
`);

export const SUBMIT = graphql(`
  mutation Submit($input: SubmitInput!) {
    submit(input: $input) {
      ...SubmissionVerdictFields
      language
      submittedAt
    }
  }
`);

export const SUBMISSION = graphql(`
  query Submission($id: ID!) {
    submission(id: $id) {
      ...SubmissionVerdictFields
      userId
      user {
        id
        username
      }
      problemId
      problem {
        id
        slug
        title
      }
      contestId
      contest {
        id
        title
      }
      language
      sourceCode
      submittedAt
    }
  }
`);

export const SUBMISSION_UPDATED = graphql(`
  subscription SubmissionUpdated($id: ID!) {
    submissionUpdated(id: $id) {
      ...SubmissionVerdictFields
    }
  }
`);

export const SUBMISSIONS = graphql(`
  query Submissions($filter: SubmissionFilter, $pageSize: Int, $pageToken: String) {
    submissions(filter: $filter, pageSize: $pageSize, pageToken: $pageToken) {
      items {
        ...SubmissionVerdictFields
        language
        submittedAt
        problemId
        problem {
          id
          slug
          title
        }
        contestId
      }
      nextPageToken
    }
  }
`);

export const CONTESTS = graphql(`
  query Contests($status: ContestStatus, $pageSize: Int, $pageToken: String) {
    contests(status: $status, pageSize: $pageSize, pageToken: $pageToken) {
      items {
        id
        title
        startTime
        endTime
        status
        problems {
          letter
          problemId
        }
      }
      nextPageToken
    }
  }
`);

export const CONTEST = graphql(`
  query Contest($id: ID!) {
    contest(id: $id) {
      id
      title
      description
      startTime
      endTime
      status
      createdById
      problems {
        letter
        problemId
        problem {
          id
          slug
          title
          difficulty
        }
      }
    }
  }
`);

export const SCOREBOARD = graphql(`
  query Scoreboard($contestId: ID!, $pageSize: Int, $pageToken: String) {
    scoreboard(contestId: $contestId, pageSize: $pageSize, pageToken: $pageToken) {
      contestId
      updatedAt
      nextPageToken
      items {
        rank
        userId
        username
        solved
        penaltyMinutes
        problems {
          letter
          problemId
          solved
          attempts
          solvedAtMinute
          penaltyMinutes
          firstToSolve
        }
      }
    }
  }
`);

export const SCOREBOARD_UPDATED = graphql(`
  subscription ScoreboardUpdated($contestId: ID!) {
    scoreboardUpdated(contestId: $contestId) {
      contestId
      submissionId
      judgedAt
    }
  }
`);

export const CREATE_CONTEST = graphql(`
  mutation CreateContest($input: CreateContestInput!) {
    createContest(input: $input) {
      id
      title
    }
  }
`);

export const ASK_ASSISTANT = graphql(`
  mutation AskAssistant($message: String!, $history: [AssistantMessageInput!]) {
    askAssistant(message: $message, history: $history) {
      message
      toolCalls {
        name
        arguments
        isError
      }
    }
  }
`);

export const USER_STATS = graphql(`
  query UserStats {
    userStats {
      userId
      username
      solvedCount
      attemptedCount
      totalSubmissions
      verdictCounts {
        verdict
        count
      }
    }
  }
`);
