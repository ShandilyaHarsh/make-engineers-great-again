"use client";

import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  ChevronDown,
  Code2,
  Eraser,
  FileCode2,
  GitPullRequest,
  ListChecks,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBlock } from "@/components/review/markdown-block";
import type {
  ChatMessage,
  DiffFile,
  DiffLine,
  Exercise,
  ExerciseIndex,
  ExerciseProgress,
  FlawProgress,
  StoredProgress,
  Verdict,
  VerifyResponse,
} from "@/lib/types";
import { cn, compactNumber, formatVerdict } from "@/lib/utils";

const STORAGE_KEY = "mega.review.progress.v1";
const fileReferencePattern = /(?:[\w@.$[\]-]+\/)*[\w@.$[\]-]+\.(?:ts|tsx|js|jsx|sql|prisma|md|go)/g;
const identifierReferencePattern = /\b[A-Za-z_$][\w$]*\b/g;

const emptyProgress: StoredProgress = {
  currentExerciseId: "TS-001",
  exercises: {},
};

type WorkspaceTab = "description" | "code" | "flaws";

type CodeFileEntry = {
  key: string;
  kind: "context" | "diff";
  file: DiffFile;
};

type CodeLocation = {
  filePath: string;
  lineNumber: number;
};

type SymbolDefinition = CodeLocation & {
  name: string;
  kind: "definition" | "import";
  source?: string;
};

type SymbolIndex = Map<string, SymbolDefinition[]>;

type TextReference = CodeLocation & {
  kind: "file" | "import" | "definition" | "occurrence";
  source?: string;
};

type TextReferenceIndex = {
  files: Map<string, TextReference>;
  symbols: Map<string, TextReference[]>;
};

type CodeIndexLine = {
  content: string;
  filePath: string;
  lineNumber: number;
};

const verdictTone: Record<Verdict, "neutral" | "success" | "warning" | "danger" | "accent"> = {
  correct: "success",
  partially_correct: "warning",
  missed: "danger",
  unverified: "accent",
};

function isWorkspaceTab(value: string | null): value is WorkspaceTab {
  return value === "description" || value === "code" || value === "flaws";
}

export function TrainingApp() {
  const [index, setIndex] = useState<ExerciseIndex | null>(null);
  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [progress, setProgress] = useState<StoredProgress>(emptyProgress);
  const [currentId, setCurrentId] = useState("TS-001");
  const [selectedFileKey, setSelectedFileKey] = useState("");
  const [activeFlawId, setActiveFlawId] = useState("");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("description");
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [jumpTarget, setJumpTarget] = useState<CodeLocation | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loadingExercise, setLoadingExercise] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatSending, setChatSending] = useState(false);

  useEffect(() => {
    const stored = readProgress();
    const params = new URLSearchParams(window.location.search);
    const queryExerciseId = params.get("pr");
    const queryTab = params.get("tab");
    const initialExerciseId = queryExerciseId || stored.currentExerciseId || "TS-001";
    const initialTab = isWorkspaceTab(queryTab) ? queryTab : "description";

    setProgress({ ...stored, currentExerciseId: initialExerciseId });
    setCurrentId(initialExerciseId);
    setActiveTab(initialTab);

    fetch("/exercises/index.json")
      .then((response) => response.json())
      .then((data: ExerciseIndex) => setIndex(data));
  }, []);

  useEffect(() => {
    if (!currentId) return;

    setLoadingExercise(true);
    fetch(`/exercises/${currentId}.json`)
      .then((response) => response.json())
      .then((data: Exercise) => {
        setExercise(data);
        setSelectedFileKey(data.diff.files[0] ? diffFileKey(data.diff.files[0]) : "");
        setJumpTarget(null);
        setActiveFlawId(data.flaws[0]?.id ?? "");
      })
      .finally(() => setLoadingExercise(false));
  }, [currentId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  }, [progress]);

  const currentProgress = useMemo(
    () => (exercise ? ensureExerciseProgress(progress.exercises[exercise.id], exercise) : null),
    [exercise, progress.exercises]
  );

  const currentIndex = useMemo(
    () => index?.exercises.findIndex((item) => item.id === currentId) ?? -1,
    [currentId, index]
  );

  const contextCodeFiles = useMemo(
    () => exercise?.contextFiles ?? [],
    [exercise]
  );

  const codeFiles = useMemo<CodeFileEntry[]>(() => {
    if (!exercise) return [];

    return [
      ...contextCodeFiles.map((file, index) => ({
        key: contextFileKey(file, index),
        kind: "context" as const,
        file,
      })),
      ...exercise.diff.files.map((file) => ({
        key: diffFileKey(file),
        kind: "diff" as const,
        file,
      })),
    ];
  }, [contextCodeFiles, exercise]);

  const selectedCodeFile = useMemo(
    () => codeFiles.find((entry) => entry.key === selectedFileKey) ?? codeFiles[0],
    [codeFiles, selectedFileKey]
  );

  const symbolIndex = useMemo(
    () => buildSymbolIndex(codeFiles.map((entry) => entry.file)),
    [codeFiles]
  );

  const textReferenceIndex = useMemo(
    () => buildTextReferenceIndex(codeFiles.map((entry) => entry.file), symbolIndex),
    [codeFiles, symbolIndex]
  );

  const completedCount = useMemo(() => {
    if (!index) return 0;
    return index.exercises.filter((item) => progress.exercises[item.id]?.submitted).length;
  }, [index, progress.exercises]);

  function goToExercise(id: string) {
    setCurrentId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("pr", id);
    url.searchParams.set("tab", activeTab);
    window.history.replaceState(null, "", url);
    setProgress((previous) => persist({ ...previous, currentExerciseId: id }));
    setMenuOpen(false);
  }

  function switchTab(tab: WorkspaceTab) {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("pr", currentId);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url);
  }

  function jumpToDefinition(definition: SymbolDefinition) {
    jumpToCodeLocation(definition);
  }

  function jumpToCodeLocation(location: CodeLocation) {
    const targetFile = codeFiles.find(
      (entry) => entry.file.newPath === location.filePath || entry.file.oldPath === location.filePath
    );
    if (targetFile) setSelectedFileKey(targetFile.key);
    switchTab("code");
    setJumpTarget({
      filePath: targetFile?.file.newPath ?? location.filePath,
      lineNumber: location.lineNumber,
    });
  }

  function renderInlineReferences(value: string) {
    return (
      <InlineReferenceText
        value={value}
        referenceIndex={textReferenceIndex}
        onNavigate={jumpToCodeLocation}
      />
    );
  }

  useEffect(() => {
    if (!jumpTarget || selectedCodeFile?.file.newPath !== jumpTarget.filePath || activeTab !== "code") return;

    const animationFrame = window.requestAnimationFrame(() => {
      const target = document.getElementById(codeLineId(jumpTarget.filePath, jumpTarget.lineNumber));
      if (!target) return;

      const scroller = target.closest<HTMLElement>("[data-code-scroll-container='true']");
      if (!scroller) {
        target.scrollIntoView({ block: "center" });
        return;
      }

      const targetRect = target.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const nextScrollTop =
        scroller.scrollTop + targetRect.top - scrollerRect.top - scroller.clientHeight / 2 + targetRect.height / 2;

      scroller.scrollTo({ top: Math.max(0, nextScrollTop) });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeTab, diffMode, jumpTarget, selectedCodeFile?.file.newPath]);

  function updateExercise(updater: (draft: ExerciseProgress) => ExerciseProgress) {
    if (!exercise) return;
    setProgress((previous) => {
      const current = ensureExerciseProgress(previous.exercises[exercise.id], exercise);
      return persist({
        ...previous,
        exercises: {
          ...previous.exercises,
          [exercise.id]: {
            ...updater(current),
            updatedAt: new Date().toISOString(),
          },
        },
      });
    });
  }

  function updateFlaw(flawId: string, updater: (draft: FlawProgress) => FlawProgress) {
    if (!exercise) return;
    updateExercise((draft) => {
      const current = draft.flaws[flawId] ?? emptyFlawProgress();
      return {
        ...draft,
        flaws: {
          ...draft.flaws,
          [flawId]: updater(current),
        },
      };
    });
  }

  function toggleLineRef(file: DiffFile, line: DiffLine) {
    const lineNumber = line.newLine ?? line.oldLine;
    if (!lineNumber || !activeFlawId) return;

    const ref = `${file.newPath}:${lineNumber}`;
    updateFlaw(activeFlawId, (draft) => {
      const exists = draft.lineRefs.includes(ref);
      return {
        ...draft,
        lineRefs: exists ? draft.lineRefs.filter((item) => item !== ref) : [...draft.lineRefs, ref],
      };
    });
  }

  async function submitReview() {
    if (!exercise || !currentProgress) return;

    setSubmitting(true);
    try {
      const answers = exercise.flaws.map((flaw) => ({
        flawId: flaw.id,
        answer: currentProgress.flaws[flaw.id]?.answer ?? "",
        lineRefs: currentProgress.flaws[flaw.id]?.lineRefs ?? [],
      }));

      const response = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exercise: {
            id: exercise.id,
            title: exercise.title,
            flaws: exercise.flaws,
            debrief: exercise.debrief,
            verdictRubric: exercise.verdictRubric,
          },
          answers,
        }),
      });
      const result = (await response.json()) as VerifyResponse;

      updateExercise((draft) => {
        const next = { ...draft.flaws };
        for (const verdict of result.verdicts) {
          next[verdict.flawId] = {
            ...(next[verdict.flawId] ?? emptyFlawProgress()),
            verdict: verdict.verdict,
            rationale: verdict.rationale,
          };
        }

        return {
          ...draft,
          submitted: true,
          submissionCount: draft.submissionCount + 1,
          flaws: next,
          overallVerdict: result.overallVerdict,
          overallRationale: result.overallRationale,
        };
      });
    } finally {
      setSubmitting(false);
    }
  }

  function clearCurrent() {
    if (!exercise) return;
    if (!window.confirm(`Clear saved progress for ${exercise.id}?`)) return;

    setProgress((previous) => {
      const next = { ...previous.exercises };
      delete next[exercise.id];
      return persist({ ...previous, exercises: next });
    });
  }

  function clearAll() {
    if (!window.confirm("Clear saved progress for all exercises?")) return;
    setProgress(persist({ ...emptyProgress, currentExerciseId: currentId }));
  }

  async function sendChat() {
    if (!exercise || !currentProgress || !chatDraft.trim()) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: chatDraft.trim(),
      createdAt: new Date().toISOString(),
    };
    setChatDraft("");
    setChatSending(true);

    const messages = [...currentProgress.chat, userMessage];
    updateExercise((draft) => ({ ...draft, chat: messages }));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submitted: currentProgress.submitted,
          exercise: buildChatExercisePayload(exercise, currentProgress.submitted),
          answers: exercise.flaws.map((flaw) => ({
            flawId: flaw.id,
            answer: currentProgress.flaws[flaw.id]?.answer ?? "",
            lineRefs: currentProgress.flaws[flaw.id]?.lineRefs ?? [],
          })),
          messages,
        }),
      });
      const data = (await response.json()) as { message: string };
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.message,
        createdAt: new Date().toISOString(),
      };
      updateExercise((draft) => ({ ...draft, chat: [...messages, assistantMessage] }));
    } finally {
      setChatSending(false);
    }
  }

  if (!index || !exercise || !currentProgress) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 rounded-lg bg-surface px-4 py-3 text-sm text-muted shadow-soft">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading training workspace&hellip;
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="min-h-screen">
      <a
        href="#flaws-tab"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-lift"
      >
        Skip to flaws
      </a>
      <header className="sticky top-0 z-40 bg-canvas/92 shadow-[0_1px_0_hsl(var(--line)),0_8px_24px_rgba(15,23,42,0.05)] backdrop-blur">
        <div className="relative flex min-h-14 items-center justify-center px-4">
          <div className="absolute left-4 hidden items-center gap-2 text-xs text-muted sm:flex">
            <GitPullRequest className="h-4 w-4 text-accent" />
            <span className="font-mono tabular-nums">{exercise.id}</span>
          </div>
          <h1 className="max-w-[72vw] truncate text-center text-sm font-semibold tracking-[0.01em] text-ink sm:text-base">
            Make Engineers Great Again
          </h1>
          <div className="absolute right-4 hidden text-xs text-muted tabular-nums sm:block">
            {completedCount}/{index.count} complete
          </div>
        </div>

        <div className="flex min-h-14 items-center gap-3 border-t border-line/70 px-4">
          <Button size="icon" variant="ghost" aria-label="Previous exercise" onClick={() => goToExercise(index.exercises[Math.max(0, currentIndex - 1)].id)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <div className="relative">
            <Button variant="secondary" className="min-w-48 justify-between" onClick={() => setMenuOpen((open) => !open)}>
              <span className="flex items-center gap-2">
                <GitPullRequest className="h-4 w-4 text-accent" />
                <span className="font-semibold tabular-nums">{exercise.id}</span>
              </span>
              <ChevronDown className="h-4 w-4 text-muted" />
            </Button>
            {menuOpen ? (
              <ProgressMenu
                index={index}
                progress={progress}
                currentId={exercise.id}
                completedCount={completedCount}
                onSelect={goToExercise}
                onClearCurrent={clearCurrent}
                onClearAll={clearAll}
              />
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{exercise.title}</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted">
              <span>{exercise.sourceRepo.label}</span>
              <span>Difficulty {exercise.difficulty}</span>
              <span className="tabular-nums">{compactNumber(exercise.representedDiffLines)} lines</span>
              <span className="tabular-nums">{completedCount}/{index.count} complete</span>
            </div>
          </div>

          <Button size="icon" variant="ghost" aria-label="Next exercise" onClick={() => goToExercise(index.exercises[Math.min(index.exercises.length - 1, currentIndex + 1)].id)}>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <nav
          aria-label="Workspace sections"
          role="tablist"
          className="flex gap-1 overflow-x-auto px-4 pb-3"
        >
          <TabButton
            active={activeTab === "description"}
            icon={<BookOpenText className="h-4 w-4" />}
            label="Description"
            onClick={() => switchTab("description")}
          />
          <TabButton
            active={activeTab === "code"}
            icon={<Code2 className="h-4 w-4" />}
            label="Code Changes"
            onClick={() => switchTab("code")}
          />
          <TabButton
            active={activeTab === "flaws"}
            icon={<ListChecks className="h-4 w-4" />}
            label="Flaws"
            onClick={() => switchTab("flaws")}
          />
        </nav>
      </header>

      <div className="p-4">
        {activeTab === "description" ? (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
              <Panel className="overflow-hidden">
                <div className="border-b border-line px-4 py-3">
                  <h2 className="text-sm font-semibold">Description</h2>
                </div>
                <div className="space-y-5 p-4">
                  <MarkdownBlock value={exercise.prDescription} renderInline={renderInlineReferences} />
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                      Existing Contracts
                    </h3>
                    <MarkdownBlock value={exercise.existingCodeContext} renderInline={renderInlineReferences} />
                  </div>
                </div>
              </Panel>

              <div className="space-y-4">
                <Panel className="overflow-hidden">
                  <div className="border-b border-line px-4 py-3">
                    <h2 className="text-sm font-semibold">Review Task</h2>
                  </div>
                  <div className="p-4">
                    <MarkdownBlock value={exercise.learnerTask} renderInline={renderInlineReferences} />
                  </div>
                </Panel>
                <Panel className="overflow-hidden">
                  <div className="border-b border-line px-4 py-3">
                    <h2 className="text-sm font-semibold">PR Shape</h2>
                  </div>
                  <div className="grid grid-cols-2 gap-3 p-4 text-sm">
                    <Metric label="Files" value={exercise.diff.fileCount} />
                    <Metric label="Diff lines" value={exercise.representedDiffLines} />
                    <Metric label="Difficulty" value={exercise.difficulty} />
                    <Metric label="Findings" value={exercise.flaws.length} />
                  </div>
                </Panel>
              </div>
            </div>

            <ChatPanel
              title={currentProgress.submitted ? "PR Discussion" : "Ask About This PR"}
              emptyText={
                currentProgress.submitted
                  ? "Ask about your submitted review, missed reasoning, or better implementation shape."
                  : "Ask about product language, domain concepts, contracts, or files in this PR."
              }
              placeholder={
                currentProgress.submitted
                  ? "Ask a follow-up after submission..."
                  : "Ask what a dataset run is..."
              }
              inputName={`${exercise.id}-description-chat-message`}
              messages={currentProgress.chat}
              draft={chatDraft}
              sending={chatSending}
              onDraftChange={setChatDraft}
              onSend={sendChat}
            />
          </div>
        ) : null}

        {activeTab === "code" ? (
          <div className="min-h-[calc(100vh-11.5rem)]">
            <Panel className="grid min-h-[calc(100vh-11.5rem)] overflow-hidden xl:grid-cols-[220px_minmax(0,1fr)]">
              <aside className="border-b border-line bg-panel/55 xl:border-b-0 xl:border-r">
                <div className="flex items-center gap-2 border-b border-line px-3 py-3">
                  <FileCode2 className="h-4 w-4 text-muted" />
                  <h2 className="text-sm font-semibold">Files</h2>
                </div>
                <div className="max-h-72 overflow-auto p-2 scrollbar-thin xl:max-h-[calc(100vh-15rem)]">
                  {contextCodeFiles.length > 0 ? (
                    <FileSection
                      title="Existing context"
                      files={codeFiles.filter((entry) => entry.kind === "context")}
                      selectedFileKey={selectedFileKey}
                      onSelect={setSelectedFileKey}
                    />
                  ) : null}
                  <FileSection
                    title="Changed files"
                    files={codeFiles.filter((entry) => entry.kind === "diff")}
                    selectedFileKey={selectedFileKey}
                    onSelect={setSelectedFileKey}
                  />
                </div>
              </aside>

              <section className="min-w-0">
                <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <h2 className="truncate font-mono text-sm font-semibold">{selectedCodeFile?.file.newPath}</h2>
                      {selectedCodeFile?.kind === "context" ? <Badge tone="neutral">Context</Badge> : null}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {selectedCodeFile?.kind === "context"
                        ? "Existing code context for review hints and contracts."
                        : "Clicking a line saves it to your active finding slot."}
                    </p>
                  </div>
                  {selectedCodeFile?.kind === "diff" ? (
                    <Button variant="secondary" onClick={() => setDiffMode(diffMode === "unified" ? "split" : "unified")}>
                      <PanelLeftClose className="h-4 w-4" />
                      {diffMode === "unified" ? "Split" : "Unified"}
                    </Button>
                  ) : null}
                </div>

                <div
                  data-code-scroll-container="true"
                  className="max-h-[calc(100vh-16.5rem)] overflow-auto bg-[#fbfcfd] font-mono text-xs leading-5 scrollbar-thin"
                >
                  {loadingExercise || !selectedCodeFile ? (
                    <div className="flex h-64 items-center justify-center gap-2 text-muted">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading diff&hellip;
                    </div>
                  ) : selectedCodeFile.kind === "context" || diffMode === "unified" ? (
                    <UnifiedDiff
                      file={selectedCodeFile.file}
                      activeRefs={selectedCodeFile.kind === "diff" ? currentProgress.flaws[activeFlawId]?.lineRefs ?? [] : []}
                      jumpTarget={jumpTarget}
                      symbolIndex={symbolIndex}
                      onNavigate={jumpToDefinition}
                      onToggle={selectedCodeFile.kind === "diff" ? toggleLineRef : noopToggleLineRef}
                    />
                  ) : (
                    <SplitDiff
                      file={selectedCodeFile.file}
                      activeRefs={currentProgress.flaws[activeFlawId]?.lineRefs ?? []}
                      jumpTarget={jumpTarget}
                      symbolIndex={symbolIndex}
                      onNavigate={jumpToDefinition}
                      onToggle={toggleLineRef}
                    />
                  )}
                </div>
              </section>
            </Panel>
          </div>
        ) : null}

        {activeTab === "flaws" ? (
          <section id="flaws-tab" className="mx-auto max-w-5xl scroll-mt-36">
            <Panel className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">Flaws</h2>
                <p className="mt-1 text-xs text-muted tabular-nums">
                  Submission {currentProgress.submissionCount}
                </p>
              </div>
              {currentProgress.submitted && currentProgress.overallVerdict ? (
                <Badge tone={verdictTone[currentProgress.overallVerdict]}>
                  {formatVerdict(currentProgress.overallVerdict)}
                </Badge>
              ) : null}
            </div>

            <div className="space-y-4 p-4">
              {exercise.flaws.map((flaw) => {
                const flawProgress = currentProgress.flaws[flaw.id] ?? emptyFlawProgress();
                const revealAnswer = currentProgress.submitted;
                return (
                  <div
                    key={flaw.id}
                    className={cn(
                      "rounded-lg p-3 shadow-[inset_0_0_0_1px_hsl(var(--line))]",
                      activeFlawId === flaw.id ? "bg-accent/5" : "bg-panel/70"
                    )}
                  >
                    <button
                      className="mb-3 flex min-h-10 w-full items-center justify-between gap-3 rounded-md text-left transition-[transform] active:scale-[0.96]"
                      onClick={() => setActiveFlawId(flaw.id)}
                    >
                      <span>
                        <span className="block text-sm font-semibold">
                          {revealAnswer ? flaw.title : `Finding slot ${flaw.number}`}
                        </span>
                        <span className="line-clamp-2 text-xs text-muted">
                          {revealAnswer
                            ? "Compare your review with the hidden answer key."
                            : "Write a real review finding. The slot label does not reveal the category."}
                        </span>
                      </span>
                      {flawProgress.verdict ? (
                        <Badge tone={verdictTone[flawProgress.verdict]}>
                          {formatVerdict(flawProgress.verdict)}
                        </Badge>
                      ) : null}
                    </button>

                    <Textarea
                      aria-label={`Answer for flaw ${flaw.number}`}
                      name={`${exercise.id}-${flaw.id}-answer`}
                      autoComplete="off"
                      value={flawProgress.answer}
                      placeholder="Describe what is wrong, why it matters, and what better implementation direction you would ask for…"
                      onChange={(event) =>
                        updateFlaw(flaw.id, (draft) => ({ ...draft, answer: event.target.value }))
                      }
                      onFocus={() => setActiveFlawId(flaw.id)}
                    />

                    <div className="mt-3 flex flex-wrap gap-2">
                      {flawProgress.lineRefs.map((ref) => (
                        <button
                          key={ref}
                          className="rounded-md bg-surface px-2 py-1 font-mono text-xs text-muted shadow-[inset_0_0_0_1px_hsl(var(--line))] transition-[transform,background-color] active:scale-[0.96] hover:bg-panel"
                          onClick={() =>
                            updateFlaw(flaw.id, (draft) => ({
                              ...draft,
                              lineRefs: draft.lineRefs.filter((item) => item !== ref),
                            }))
                          }
                        >
                          {ref}
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 space-y-2">
                      {flaw.hints.slice(0, flawProgress.revealedHints).map((hint, index) => (
                        <div key={index} className="rounded-md bg-warning/10 p-2 text-xs leading-5 text-ink">
                          <span className="font-semibold tabular-nums">Hint {index + 1}: </span>
                          {renderInlineReferences(hint)}
                        </div>
                      ))}
                      {flawProgress.revealedHints < flaw.hints.length ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            updateFlaw(flaw.id, (draft) => ({
                              ...draft,
                              revealedHints: Math.min(flaw.hints.length, draft.revealedHints + 1),
                            }))
                          }
                        >
                          <Sparkles className="h-4 w-4" />
                          Hint {flawProgress.revealedHints + 1}
                        </Button>
                      ) : null}
                    </div>

                    {currentProgress.submitted ? (
                      <div className="mt-3 space-y-3 rounded-md bg-surface p-3 shadow-[inset_0_0_0_1px_hsl(var(--line))]">
                        {flawProgress.rationale ? (
                          <p className="text-xs leading-5 text-muted">
                            {renderInlineReferences(flawProgress.rationale)}
                          </p>
                        ) : null}
                        <div>
                          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                            Golden Answer
                          </h4>
                          <MarkdownBlock
                            value={flaw.goldenAnswer || flaw.expectedIdentification}
                            renderInline={renderInlineReferences}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}

              <div className="flex gap-2">
                <Button className="flex-1" variant="primary" onClick={submitReview} disabled={submitting}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {currentProgress.submitted ? "Resubmit" : "Submit"}
                </Button>
                <Button variant="secondary" onClick={clearCurrent}>
                  <RotateCcw className="h-4 w-4" />
                  Clear
                </Button>
              </div>

              {currentProgress.submitted ? (
                <>
                  <Panel className="overflow-hidden bg-panel/70">
                    <div className="border-b border-line px-4 py-3">
                      <h3 className="text-sm font-semibold">Expert Debrief</h3>
                    </div>
                    <div className="p-4">
                      <MarkdownBlock value={exercise.debrief.raw} renderInline={renderInlineReferences} />
                    </div>
                  </Panel>

                  <ChatPanel
                    title="PR Discussion"
                    emptyText="Ask about your submitted review, missed reasoning, or better implementation shape."
                    placeholder="Ask a follow-up after submission..."
                    inputName={`${exercise.id}-discussion-message`}
                    messages={currentProgress.chat}
                    draft={chatDraft}
                    sending={chatSending}
                    onDraftChange={setChatDraft}
                    onSend={sendChat}
                  />
                </>
              ) : null}
            </div>
          </Panel>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function ChatPanel({
  title,
  emptyText,
  placeholder,
  inputName,
  messages,
  draft,
  sending,
  onDraftChange,
  onSend,
}: {
  title: string;
  emptyText: string;
  placeholder: string;
  inputName: string;
  messages: ChatMessage[];
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}) {
  return (
    <Panel className="overflow-hidden bg-panel/70">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <MessageSquare className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="max-h-72 space-y-3 overflow-auto p-4 scrollbar-thin">
        {messages.length === 0 ? (
          <p className="text-pretty text-sm leading-6 text-muted">{emptyText}</p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "rounded-md p-3 text-sm leading-6 shadow-[inset_0_0_0_1px_hsl(var(--line))]",
                message.role === "user" ? "bg-surface" : "bg-accent/5"
              )}
            >
              <div className="mb-1 text-xs font-semibold capitalize text-muted">{message.role}</div>
              <p className="text-pretty whitespace-pre-wrap">{message.content}</p>
            </div>
          ))
        )}
      </div>
      <form
        className="border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <Textarea
          aria-label={title}
          name={inputName}
          autoComplete="off"
          className="min-h-24"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <Button type="submit" className="mt-2 w-full" disabled={sending || !draft.trim()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
          Send
        </Button>
      </form>
    </Panel>
  );
}

function buildChatExercisePayload(exercise: Exercise, submitted: boolean) {
  return {
    publicContext: {
      id: exercise.id,
      title: exercise.title,
      sourceRepo: exercise.sourceRepo,
      repoArea: exercise.repoArea,
      difficulty: exercise.difficulty,
      representedDiffLines: exercise.representedDiffLines,
      prDescription: exercise.prDescription,
      existingCodeContext: exercise.existingCodeContext,
      learnerTask: exercise.learnerTask,
      reviewSurface: exercise.reviewSurface,
      diffSummary: {
        fileCount: exercise.diff.fileCount,
        additions: exercise.diff.additions,
        deletions: exercise.diff.deletions,
        files: exercise.diff.files.map((file) => ({
          path: file.newPath,
          language: file.language,
          additions: file.additions,
          deletions: file.deletions,
          hunks: file.hunks.map((hunk) => hunk.header),
        })),
      },
    },
    hiddenAnswerKey: submitted
      ? {
          flaws: exercise.flaws,
          debrief: exercise.debrief,
          verdictRubric: exercise.verdictRubric,
        }
      : null,
  };
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        "inline-flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-medium outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-accent/35",
        active
          ? "bg-surface text-ink shadow-[inset_0_0_0_1px_hsl(var(--line)),0_1px_2px_rgba(15,23,42,0.04)]"
          : "text-muted hover:bg-panel hover:text-ink"
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-panel p-3 shadow-[inset_0_0_0_1px_hsl(var(--line))]">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-ink">{compactNumber(value)}</div>
    </div>
  );
}

function FileSection({
  title,
  files,
  selectedFileKey,
  onSelect,
}: {
  title: string;
  files: CodeFileEntry[];
  selectedFileKey: string;
  onSelect: (key: string) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="mb-3 last:mb-0">
      <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {title}
      </div>
      <div className="space-y-1">
        {files.map((entry) => (
          <button
            key={entry.key}
            type="button"
            title={entry.file.newPath}
            aria-label={entry.file.newPath}
            className={cn(
              "group flex min-h-10 w-full items-start gap-2 rounded-md px-2 py-2 text-left text-[11px] leading-4 transition-[background-color,color,transform] duration-150 active:scale-[0.96]",
              selectedFileKey === entry.key ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface hover:text-ink"
            )}
            onClick={() => onSelect(entry.key)}
          >
            <span
              className={cn(
                "mt-1 h-2 w-2 shrink-0 rounded-full bg-line group-hover:bg-muted",
                entry.kind === "context" && "bg-warning/70 group-hover:bg-warning"
              )}
            />
            <span className="min-w-0 flex-1 whitespace-normal break-words font-mono">
              {fileNameForDisplay(entry.file.newPath)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function fileNameForDisplay(filePath: string) {
  return filePath.split("/").pop() ?? filePath;
}

function InlineReferenceText({
  value,
  referenceIndex,
  onNavigate,
}: {
  value: string;
  referenceIndex: TextReferenceIndex;
  onNavigate: (location: CodeLocation) => void;
}) {
  const segments = value.split(/(`[^`]+`)/g);

  return (
    <>
      {segments.map((segment, segmentIndex) => {
        const codeLike = segment.startsWith("`") && segment.endsWith("`");
        const text = codeLike ? segment.slice(1, -1) : segment;
        const parts = tokenizeTextReferences(text, referenceIndex);

        return parts.map((part, partIndex) => {
          const key = `${segmentIndex}-${partIndex}-${part.value}`;

          if (part.type === "text") {
            return codeLike ? (
              <code key={key} className="rounded bg-panel px-1 py-0.5 font-mono text-[0.92em] text-ink">
                {part.value}
              </code>
            ) : (
              <span key={key}>{part.value}</span>
            );
          }

          return (
            <button
              key={key}
              type="button"
              title={textReferenceTitle(part.reference)}
              className={cn(
                "inline appearance-none rounded-sm border-0 bg-transparent p-0 font-mono text-[0.95em] text-accent underline decoration-accent/45 underline-offset-2 outline-none transition-[background-color,color,box-shadow] hover:bg-accent/10 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/35",
                codeLike && "px-1 py-0.5"
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onNavigate(part.reference);
              }}
            >
              {part.value}
            </button>
          );
        });
      })}
    </>
  );
}

type TextReferencePart =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "reference";
      value: string;
      reference: TextReference;
    };

function tokenizeTextReferences(value: string, referenceIndex: TextReferenceIndex): TextReferencePart[] {
  if (!value || (referenceIndex.files.size === 0 && referenceIndex.symbols.size === 0)) {
    return [{ type: "text", value }];
  }

  const matches: Array<{
    start: number;
    end: number;
    value: string;
    reference: TextReference;
  }> = [];

  for (const match of value.matchAll(fileReferencePattern)) {
    const rawPath = match[0];
    const start = match.index;
    if (start === undefined) continue;

    const reference = referenceIndex.files.get(rawPath);
    if (!reference) continue;

    matches.push({
      start,
      end: start + rawPath.length,
      value: rawPath,
      reference,
    });
  }

  for (const match of value.matchAll(identifierReferencePattern)) {
    const name = match[0];
    const start = match.index;
    if (start === undefined || isInsideRange(start, matches)) continue;

    const reference = resolveTextSymbolReference(name, value, start, referenceIndex);
    if (!reference) continue;

    matches.push({
      start,
      end: start + name.length,
      value: name,
      reference,
    });
  }

  if (matches.length === 0) return [{ type: "text", value }];

  const parts: TextReferencePart[] = [];
  let cursor = 0;

  for (const match of matches.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (match.start < cursor) continue;
    if (match.start > cursor) {
      parts.push({ type: "text", value: value.slice(cursor, match.start) });
    }
    parts.push({
      type: "reference",
      value: match.value,
      reference: match.reference,
    });
    cursor = match.end;
  }

  if (cursor < value.length) {
    parts.push({ type: "text", value: value.slice(cursor) });
  }

  return parts;
}

function buildTextReferenceIndex(files: DiffFile[], symbolIndex: SymbolIndex): TextReferenceIndex {
  const referenceIndex: TextReferenceIndex = {
    files: new Map(),
    symbols: new Map(),
  };
  const basenameCounts = new Map<string, number>();

  for (const file of files) {
    const basename = fileNameForDisplay(file.newPath);
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }

  for (const file of files) {
    const lineNumber = firstLineNumber(file);
    const fileReference: TextReference = {
      kind: "file",
      filePath: file.newPath,
      lineNumber,
    };
    referenceIndex.files.set(file.newPath, fileReference);

    const basename = fileNameForDisplay(file.newPath);
    if (basenameCounts.get(basename) === 1) {
      referenceIndex.files.set(basename, fileReference);
    }
  }

  for (const definitions of symbolIndex.values()) {
    for (const definition of definitions) {
      addTextSymbolReference(referenceIndex, definition.name, {
        kind: definition.kind,
        source: definition.source,
        filePath: definition.filePath,
        lineNumber: definition.lineNumber,
      });
    }
  }

  for (const file of files) {
    for (const line of getIndexableLines(file)) {
      for (const match of line.content.matchAll(callTargetPattern)) {
        const name = match[1];
        const start = match.index;
        if (!name || start === undefined || nonNavigableCallNames.has(name) || isPropertyAccess(line.content, start)) {
          continue;
        }

        addTextSymbolReference(referenceIndex, name, {
          kind: "occurrence",
          filePath: line.filePath,
          lineNumber: line.lineNumber,
        });
      }
    }
  }

  return referenceIndex;
}

function addTextSymbolReference(referenceIndex: TextReferenceIndex, name: string, reference: TextReference) {
  const references = referenceIndex.symbols.get(name) ?? [];
  const alreadyExists = references.some(
    (existing) => existing.filePath === reference.filePath && existing.lineNumber === reference.lineNumber
  );
  if (!alreadyExists) references.push(reference);
  referenceIndex.symbols.set(name, references);
}

function resolveTextSymbolReference(
  name: string,
  text: string,
  start: number,
  referenceIndex: TextReferenceIndex
) {
  const references = referenceIndex.symbols.get(name);
  if (!references || nonNavigableCallNames.has(name)) return null;

  const nearbyFile = findNearbyFileReference(text, start, referenceIndex);
  const scopedReferences = nearbyFile
    ? references.filter((reference) => reference.filePath === nearbyFile.filePath)
    : references;
  const candidates = scopedReferences.length > 0 ? scopedReferences : references;

  return (
    candidates.find((reference) => reference.kind === "definition") ??
    candidates.find((reference) => reference.kind === "occurrence") ??
    candidates[0] ??
    null
  );
}

function findNearbyFileReference(text: string, start: number, referenceIndex: TextReferenceIndex) {
  const windowStart = Math.max(0, start - 140);
  const windowEnd = Math.min(text.length, start + 180);
  const nearbyText = text.slice(windowStart, windowEnd);

  for (const match of nearbyText.matchAll(fileReferencePattern)) {
    const reference = referenceIndex.files.get(match[0]);
    if (reference) return reference;
  }

  return null;
}

function firstLineNumber(file: DiffFile) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const lineNumber = line.newLine ?? line.oldLine;
      if (lineNumber) return lineNumber;
    }
  }

  return 1;
}

function isInsideRange(index: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function textReferenceTitle(reference: TextReference) {
  const kind =
    reference.kind === "file"
      ? "file"
      : reference.kind === "import" && reference.source
        ? `import from ${reference.source}`
      : reference.kind === "occurrence"
        ? "visible code occurrence"
        : reference.kind;

  return `Jump to ${kind} at ${reference.filePath}:${reference.lineNumber}`;
}

function diffFileKey(file: DiffFile) {
  return `diff:${file.newPath}`;
}

function contextFileKey(file: DiffFile, index: number) {
  return `context:${index}:${file.newPath}`;
}

function noopToggleLineRef() {}

function UnifiedDiff({
  file,
  activeRefs,
  jumpTarget,
  symbolIndex,
  onNavigate,
  onToggle,
}: {
  file: DiffFile;
  activeRefs: string[];
  jumpTarget: CodeLocation | null;
  symbolIndex: SymbolIndex;
  onNavigate: (definition: SymbolDefinition) => void;
  onToggle: (file: DiffFile, line: DiffLine) => void;
}) {
  return (
    <div>
      {file.hunks.map((hunk) => (
        <div key={hunk.header}>
          <div className="bg-accent/10 px-4 py-1 font-mono text-[11px] text-accent">{hunk.header}</div>
          {hunk.lines.map((line, index) => {
            const lineNumber = line.newLine ?? line.oldLine;
            const ref = lineNumber ? `${file.newPath}:${lineNumber}` : "";
            const selected = activeRefs.includes(ref);
            const highlighted = Boolean(
              lineNumber && jumpTarget?.filePath === file.newPath && jumpTarget.lineNumber === lineNumber
            );
            return (
              <DiffLineRow
                key={`${hunk.header}-${index}`}
                id={lineNumber ? codeLineId(file.newPath, lineNumber) : undefined}
                line={line}
                file={file}
                className={cn(
                  "grid-cols-[64px_64px_1fr]",
                  line.type === "add" && "bg-success/10",
                  line.type === "delete" && "bg-danger/10",
                  selected && "bg-accent/15",
                  highlighted && "bg-warning/15 ring-1 ring-inset ring-warning/50"
                )}
                onToggle={onToggle}
              >
                <span className="select-none border-r border-line/70 px-2 text-right text-muted tabular-nums">
                  {line.oldLine ?? ""}
                </span>
                <span className="select-none border-r border-line/70 px-2 text-right text-muted tabular-nums">
                  {line.newLine ?? ""}
                </span>
                <code className="whitespace-pre px-3">
                  <span className={cn(line.type === "add" && "text-success", line.type === "delete" && "text-danger")}>
                    {line.type === "add" ? "+" : line.type === "delete" ? "-" : " "}
                  </span>
                  <CodeLine
                    content={line.content}
                    filePath={file.newPath}
                    lineNumber={lineNumber}
                    symbolIndex={symbolIndex}
                    onNavigate={onNavigate}
                  />
                </code>
              </DiffLineRow>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SplitDiff({
  file,
  activeRefs,
  jumpTarget,
  symbolIndex,
  onNavigate,
  onToggle,
}: {
  file: DiffFile;
  activeRefs: string[];
  jumpTarget: CodeLocation | null;
  symbolIndex: SymbolIndex;
  onNavigate: (definition: SymbolDefinition) => void;
  onToggle: (file: DiffFile, line: DiffLine) => void;
}) {
  return (
    <div>
      {file.hunks.map((hunk) => (
        <div key={hunk.header}>
          <div className="bg-accent/10 px-4 py-1 font-mono text-[11px] text-accent">{hunk.header}</div>
          {hunk.lines.map((line, index) => {
            const lineNumber = line.newLine ?? line.oldLine;
            const ref = lineNumber ? `${file.newPath}:${lineNumber}` : "";
            const selected = activeRefs.includes(ref);
            const highlighted = Boolean(
              lineNumber && jumpTarget?.filePath === file.newPath && jumpTarget.lineNumber === lineNumber
            );
            const oldContent = line.type === "add" ? "" : line.content;
            const newContent = line.type === "delete" ? "" : line.content;
            return (
              <DiffLineRow
                key={`${hunk.header}-${index}`}
                id={lineNumber ? codeLineId(file.newPath, lineNumber) : undefined}
                line={line}
                file={file}
                className={cn(
                  "grid-cols-[64px_minmax(0,1fr)_64px_minmax(0,1fr)]",
                  selected && "bg-accent/15",
                  highlighted && "bg-warning/15 ring-1 ring-inset ring-warning/50"
                )}
                onToggle={onToggle}
              >
                <span className="select-none border-r border-line/70 px-2 text-right text-muted tabular-nums">
                  {line.oldLine ?? ""}
                </span>
                <code className={cn("whitespace-pre border-r border-line/70 px-3", line.type === "delete" && "bg-danger/10 text-danger")}>
                  <CodeLine
                    content={oldContent}
                    filePath={file.newPath}
                    lineNumber={line.oldLine}
                    symbolIndex={symbolIndex}
                    onNavigate={onNavigate}
                  />
                </code>
                <span className="select-none border-r border-line/70 px-2 text-right text-muted tabular-nums">
                  {line.newLine ?? ""}
                </span>
                <code className={cn("whitespace-pre px-3", line.type === "add" && "bg-success/10 text-success")}>
                  <CodeLine
                    content={newContent}
                    filePath={file.newPath}
                    lineNumber={line.newLine}
                    symbolIndex={symbolIndex}
                    onNavigate={onNavigate}
                  />
                </code>
              </DiffLineRow>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DiffLineRow({
  id,
  file,
  line,
  className,
  children,
  onToggle,
}: {
  id?: string;
  file: DiffFile;
  line: DiffLine;
  className?: string;
  children: ReactNode;
  onToggle: (file: DiffFile, line: DiffLine) => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle(file, line);
  }

  return (
    <div
      id={id}
      role="button"
      tabIndex={0}
      className={cn(
        "content-visibility-auto grid min-h-6 w-full text-left outline-none transition-[background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent/35",
        className
      )}
      onClick={() => onToggle(file, line)}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

function CodeLine({
  content,
  filePath,
  lineNumber,
  symbolIndex,
  onNavigate,
}: {
  content: string;
  filePath: string;
  lineNumber: number | null;
  symbolIndex: SymbolIndex;
  onNavigate: (definition: SymbolDefinition) => void;
}) {
  if (!lineNumber || symbolIndex.size === 0 || !content) return <>{content}</>;

  const parts = tokenizeCodeLine(content, filePath, lineNumber, symbolIndex);
  if (parts.length === 1 && parts[0]?.type === "text") return <>{content}</>;

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") return <span key={index}>{part.value}</span>;

        return (
          <button
            key={`${part.value}-${index}`}
            type="button"
            title={navigationTitle(part.definition)}
            className="inline appearance-none rounded-sm border-0 bg-transparent p-0 font-mono text-blue-600 underline decoration-blue-500/50 underline-offset-2 outline-none transition-[background-color,color,box-shadow] hover:bg-blue-50 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500/35"
            onClick={(event) => handleCodeTokenClick(event, part.definition, onNavigate)}
            onKeyDown={(event) => handleCodeTokenKeyDown(event, part.definition, onNavigate)}
          >
            {part.value}
          </button>
        );
      })}
    </>
  );
}

type CodeLinePart =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "link";
      value: string;
      definition: SymbolDefinition;
    };

const callTargetPattern = /\b([A-Za-z_$][\w$]*)\s*(?=\()/g;
const functionDefinitionPatterns = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/,
  /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
];
const nonNavigableCallNames = new Set([
  "catch",
  "constructor",
  "for",
  "function",
  "if",
  "new",
  "return",
  "switch",
  "throw",
  "typeof",
  "while",
]);

function buildSymbolIndex(files: DiffFile[]): SymbolIndex {
  const index: SymbolIndex = new Map();

  for (const file of files) {
    const lines = getIndexableLines(file);
    addImportBindings(index, lines);

    for (const line of lines) {
      const name = findDefinedFunctionName(line.content);
      if (!name) continue;

      addSymbol(index, {
        name,
        kind: "definition",
        filePath: line.filePath,
        lineNumber: line.lineNumber,
      });
    }
  }

  return index;
}

function getIndexableLines(file: DiffFile): CodeIndexLine[] {
  return file.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) => {
      const lineNumber = line.newLine ?? line.oldLine;
      return lineNumber
        ? [
            {
              content: line.content,
              filePath: file.newPath,
              lineNumber,
            },
          ]
        : [];
    })
  );
}

function addImportBindings(index: SymbolIndex, lines: CodeIndexLine[]) {
  let importBlock: CodeIndexLine[] = [];

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (importBlock.length === 0 && !trimmed.startsWith("import ")) continue;

    importBlock.push(line);
    if (!isCompleteImportBlock(importBlock)) continue;

    for (const binding of parseImportBindings(importBlock)) {
      addSymbol(index, binding);
    }
    importBlock = [];
  }
}

function isCompleteImportBlock(lines: CodeIndexLine[]) {
  const combined = lines.map((line) => line.content.trim()).join(" ");
  return /(?:^|\s)from\s+["'][^"']+["'];?$/.test(combined) || /^import\s+["'][^"']+["'];?$/.test(combined);
}

function parseImportBindings(lines: CodeIndexLine[]): SymbolDefinition[] {
  const combined = lines.map((line) => line.content.trim()).join(" ");
  const source = combined.match(/\sfrom\s+["']([^"']+)["']/)?.[1];
  if (!source) return [];

  const bindings: SymbolDefinition[] = [];
  const namespaceMatch = combined.match(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/);
  const defaultMatch = combined.match(/^import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from\b)/);
  const namedMatch = combined.match(/\{([^}]*)\}/);

  if (namespaceMatch?.[1]) {
    bindings.push(importBinding(namespaceMatch[1], source, lines));
  }

  if (defaultMatch?.[1]) {
    bindings.push(importBinding(defaultMatch[1], source, lines));
  }

  if (!namedMatch?.[1]) return bindings;

  for (const rawSpecifier of namedMatch[1].split(",")) {
    const specifier = rawSpecifier.trim();
    if (!specifier) continue;

    const cleaned = specifier.replace(/^type\s+/, "").trim();
    if (!cleaned) continue;

    const [imported, local = imported] = cleaned.split(/\s+as\s+/).map((part) => part.trim());
    if (!imported || !local) continue;

    bindings.push(importBinding(local, source, lines, [local, imported]));
  }

  return bindings;
}

function importBinding(name: string, source: string, lines: CodeIndexLine[], searchNames: string[] = [name]) {
  const lineNumber =
    lines.find((line) => searchNames.some((searchName) => hasIdentifier(line.content, searchName)))?.lineNumber ??
    lines[0]?.lineNumber ??
    1;

  return {
    name,
    kind: "import" as const,
    source,
    filePath: lines[0]?.filePath ?? "",
    lineNumber,
  };
}

function addSymbol(index: SymbolIndex, definition: SymbolDefinition) {
  const definitions = index.get(definition.name) ?? [];
  definitions.push(definition);
  index.set(definition.name, definitions);
}

function findDefinedFunctionName(content: string) {
  const trimmed = content.trim();

  for (const pattern of functionDefinitionPatterns) {
    const match = trimmed.match(pattern);
    const name = match?.[1];
    if (name && !nonNavigableCallNames.has(name)) return name;
  }

  return null;
}

function tokenizeCodeLine(
  content: string,
  filePath: string,
  lineNumber: number,
  symbolIndex: SymbolIndex
): CodeLinePart[] {
  const parts: CodeLinePart[] = [];
  const definedName = findDefinedFunctionName(content);
  let cursor = 0;

  for (const match of content.matchAll(callTargetPattern)) {
    const name = match[1];
    const start = match.index;
    if (!name || start === undefined) continue;

    const definition = resolveSymbolDefinition(name, filePath, lineNumber, symbolIndex);
    if (
      !definition ||
      name === definedName ||
      nonNavigableCallNames.has(name) ||
      isPropertyAccess(content, start)
    ) {
      continue;
    }

    if (start > cursor) {
      parts.push({ type: "text", value: content.slice(cursor, start) });
    }
    parts.push({
      type: "link",
      value: name,
      definition,
    });
    cursor = start + name.length;
  }

  if (cursor < content.length) {
    parts.push({ type: "text", value: content.slice(cursor) });
  }

  return parts.length > 0 ? parts : [{ type: "text", value: content }];
}

function resolveSymbolDefinition(
  name: string,
  filePath: string,
  lineNumber: number,
  symbolIndex: SymbolIndex
) {
  const definitions = symbolIndex.get(name);
  if (!definitions) return null;

  const candidates = definitions.filter(
    (definition) => definition.filePath !== filePath || definition.lineNumber !== lineNumber
  );
  return candidates.find((definition) => definition.filePath === filePath) ?? candidates[0] ?? null;
}

function isPropertyAccess(content: string, start: number) {
  let index = start - 1;
  while (index >= 0 && /\s/.test(content[index] ?? "")) index -= 1;
  return content[index] === ".";
}

function hasIdentifier(content: string, identifier: string) {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(content);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function navigationTitle(definition: SymbolDefinition) {
  const target =
    definition.kind === "import" && definition.source
      ? `import from ${definition.source}`
      : "definition";

  return `Cmd/Ctrl-click to jump to ${target} at ${definition.filePath}:${definition.lineNumber}`;
}

function handleCodeTokenClick(
  event: MouseEvent<HTMLButtonElement>,
  definition: SymbolDefinition,
  onNavigate: (definition: SymbolDefinition) => void
) {
  if (!event.metaKey && !event.ctrlKey) return;
  event.preventDefault();
  event.stopPropagation();
  onNavigate(definition);
}

function handleCodeTokenKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  definition: SymbolDefinition,
  onNavigate: (definition: SymbolDefinition) => void
) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.stopPropagation();
  onNavigate(definition);
}

function codeLineId(filePath: string, lineNumber: number) {
  return `code-line-${filePath.replace(/[^a-zA-Z0-9_-]/g, "_")}-${lineNumber}`;
}

function ProgressMenu({
  index,
  progress,
  currentId,
  completedCount,
  onSelect,
  onClearCurrent,
  onClearAll,
}: {
  index: ExerciseIndex;
  progress: StoredProgress;
  currentId: string;
  completedCount: number;
  onSelect: (id: string) => void;
  onClearCurrent: () => void;
  onClearAll: () => void;
}) {
  return (
    <div className="absolute left-0 top-12 z-50 w-[420px] overflow-hidden rounded-lg bg-surface shadow-lift">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Progress</div>
          <div className="mt-1 text-xs text-muted tabular-nums">
            {completedCount}/{index.count} submitted
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onClearCurrent}>
            <Eraser className="h-4 w-4" />
            Current
          </Button>
          <Button size="sm" variant="danger" onClick={onClearAll}>
            <Eraser className="h-4 w-4" />
            All
          </Button>
        </div>
      </div>
      <div className="grid max-h-[520px] grid-cols-2 gap-1 overflow-auto p-2 scrollbar-thin">
        {index.exercises.map((item) => {
          const itemProgress = progress.exercises[item.id];
          return (
            <button
              key={item.id}
              className={cn(
                "content-visibility-auto min-h-14 rounded-md px-3 text-left transition-[background-color,transform] active:scale-[0.96]",
                currentId === item.id ? "bg-accent/10 text-accent" : "hover:bg-panel"
              )}
              onClick={() => onSelect(item.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold tabular-nums">{item.id}</span>
                {itemProgress?.submitted ? <Badge tone="success">done</Badge> : null}
              </div>
              <div className="mt-1 truncate text-xs text-muted">{item.title}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function emptyFlawProgress(): FlawProgress {
  return {
    answer: "",
    lineRefs: [],
    revealedHints: 0,
  };
}

function ensureExerciseProgress(existing: ExerciseProgress | undefined, exercise: Exercise): ExerciseProgress {
  const flaws = { ...(existing?.flaws ?? {}) };
  for (const flaw of exercise.flaws) {
    flaws[flaw.id] = {
      ...emptyFlawProgress(),
      ...(flaws[flaw.id] ?? {}),
    };
  }

  return {
    submitted: existing?.submitted ?? false,
    submissionCount: existing?.submissionCount ?? 0,
    flaws,
    overallVerdict: existing?.overallVerdict,
    overallRationale: existing?.overallRationale,
    chat: existing?.chat ?? [],
    updatedAt: existing?.updatedAt ?? new Date().toISOString(),
  };
}

function readProgress(): StoredProgress {
  if (typeof window === "undefined") return emptyProgress;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyProgress;

  try {
    return { ...emptyProgress, ...JSON.parse(raw) };
  } catch {
    return emptyProgress;
  }
}

function persist(progress: StoredProgress) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  return progress;
}
