export type Verdict = "correct" | "partially_correct" | "missed" | "unverified";

export type ExerciseIndexItem = {
  id: string;
  slug: string;
  title: string;
  sourceRepo: {
    label: string;
    url: string;
  };
  difficulty: number;
  representedDiffLines: number;
  flawCount: number;
  fileName: string;
};

export type ExerciseIndex = {
  generatedAt: string;
  count: number;
  exercises: ExerciseIndexItem[];
};

export type DiffLine = {
  id: string;
  type: "add" | "delete" | "context";
  oldLine: number | null;
  newLine: number | null;
  content: string;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath: string;
  newPath: string;
  language: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

export type ExerciseFlaw = {
  id: string;
  number: number;
  title: string;
  prompt: string;
  expectedIdentification: string;
  expectedImpact: string;
  expectedFix: string;
  goldenAnswer: string;
  hints: string[];
};

export type Exercise = {
  id: string;
  slug: string;
  title: string;
  sourceFile: string;
  sourceRepo: {
    label: string;
    url: string;
  };
  repoArea: string;
  difficulty: number;
  targetDiffLines: string | number;
  representedDiffLines: number;
  mode: string;
  prDescription: string;
  existingCodeContext: string;
  contextFiles?: DiffFile[];
  learnerTask: string;
  reviewSurface: string[];
  diff: {
    raw: string;
    files: DiffFile[];
    fileCount: number;
    additions: number;
    deletions: number;
  };
  flaws: ExerciseFlaw[];
  debrief: {
    raw: string;
    productLevelChange: string;
    changedContracts: string;
    failureModes: string;
    reviewerThoughtProcess: string;
    betterImplementation: string;
  };
  verdictRubric: string;
};

export type FlawProgress = {
  answer: string;
  lineRefs: string[];
  revealedHints: number;
  verdict?: Verdict;
  rationale?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type ExerciseProgress = {
  submitted: boolean;
  submissionCount: number;
  flaws: Record<string, FlawProgress>;
  overallVerdict?: Verdict;
  overallRationale?: string;
  chat: ChatMessage[];
  updatedAt: string;
};

export type StoredProgress = {
  currentExerciseId: string;
  exercises: Record<string, ExerciseProgress>;
};

export type VerifyResponse = {
  mode: "model" | "unverified";
  verdicts: Array<{
    flawId: string;
    verdict: Verdict;
    rationale: string;
  }>;
  overallVerdict: Verdict;
  overallRationale: string;
};
