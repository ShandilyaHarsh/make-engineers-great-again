"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
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

const emptyProgress: StoredProgress = {
  currentExerciseId: "TS-001",
  exercises: {},
};

type WorkspaceTab = "description" | "code" | "flaws";

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
  const [selectedFile, setSelectedFile] = useState("");
  const [activeFlawId, setActiveFlawId] = useState("");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("description");
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
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
        setSelectedFile(data.diff.files[0]?.newPath ?? "");
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

  const selectedDiffFile = useMemo(
    () => exercise?.diff.files.find((file) => file.newPath === selectedFile) ?? exercise?.diff.files[0],
    [exercise, selectedFile]
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
          exercise: {
            id: exercise.id,
            title: exercise.title,
            flaws: exercise.flaws,
            debrief: exercise.debrief,
            verdictRubric: exercise.verdictRubric,
          },
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
        <div className="flex min-h-16 items-center gap-3 px-4">
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
            <p className="truncate text-sm font-semibold text-ink">make engineers great again.</p>
            <h1 className="mt-0.5 truncate text-xs font-medium text-muted">{exercise.title}</h1>
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
          <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
            <Panel className="overflow-hidden">
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold">Description</h2>
              </div>
              <div className="space-y-5 p-4">
                <MarkdownBlock value={exercise.prDescription} />
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    Existing Contracts
                  </h3>
                  <MarkdownBlock value={exercise.existingCodeContext} />
                </div>
              </div>
            </Panel>

            <div className="space-y-4">
              <Panel className="overflow-hidden">
                <div className="border-b border-line px-4 py-3">
                  <h2 className="text-sm font-semibold">Review Task</h2>
                </div>
                <div className="p-4">
                  <MarkdownBlock value={exercise.learnerTask} />
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
        ) : null}

        {activeTab === "code" ? (
          <div className="min-h-[calc(100vh-8.25rem)]">
            <Panel className="grid min-h-[calc(100vh-8.25rem)] overflow-hidden xl:grid-cols-[220px_minmax(0,1fr)]">
              <aside className="border-b border-line bg-panel/55 xl:border-b-0 xl:border-r">
                <div className="flex items-center gap-2 border-b border-line px-3 py-3">
                  <FileCode2 className="h-4 w-4 text-muted" />
                  <h2 className="text-sm font-semibold">Files</h2>
                </div>
                <div className="max-h-72 overflow-auto p-2 scrollbar-thin xl:max-h-[calc(100vh-11.5rem)]">
                  {exercise.diff.files.map((file) => (
                    <button
                      key={file.newPath}
                      title={file.newPath}
                      aria-label={file.newPath}
                      className={cn(
                        "group flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-[background-color,color,transform] duration-150 active:scale-[0.96]",
                        selectedFile === file.newPath ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface hover:text-ink"
                      )}
                      onClick={() => setSelectedFile(file.newPath)}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full bg-line group-hover:bg-muted" />
                      <span className="min-w-0 flex-1 truncate font-mono">{compactFileName(file.newPath)}</span>
                    </button>
                  ))}
                </div>
              </aside>

              <section className="min-w-0">
                <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-mono text-sm font-semibold">{selectedDiffFile?.newPath}</h2>
                    <p className="mt-1 text-xs text-muted">Clicking a line saves it to your active finding slot.</p>
                  </div>
                  <Button variant="secondary" onClick={() => setDiffMode(diffMode === "unified" ? "split" : "unified")}>
                    <PanelLeftClose className="h-4 w-4" />
                    {diffMode === "unified" ? "Split" : "Unified"}
                  </Button>
                </div>

                <div className="max-h-[calc(100vh-13rem)] overflow-auto bg-[#fbfcfd] font-mono text-xs leading-5 scrollbar-thin">
                  {loadingExercise || !selectedDiffFile ? (
                    <div className="flex h-64 items-center justify-center gap-2 text-muted">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading diff&hellip;
                    </div>
                  ) : diffMode === "unified" ? (
                    <UnifiedDiff
                      file={selectedDiffFile}
                      activeRefs={currentProgress.flaws[activeFlawId]?.lineRefs ?? []}
                      onToggle={toggleLineRef}
                    />
                  ) : (
                    <SplitDiff
                      file={selectedDiffFile}
                      activeRefs={currentProgress.flaws[activeFlawId]?.lineRefs ?? []}
                      onToggle={toggleLineRef}
                    />
                  )}
                </div>
              </section>
            </Panel>
          </div>
        ) : null}

        {activeTab === "flaws" ? (
          <section id="flaws-tab" className="mx-auto max-w-5xl scroll-mt-28">
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
                          {hint}
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
                          <p className="text-xs leading-5 text-muted">{flawProgress.rationale}</p>
                        ) : null}
                        <div>
                          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                            Golden Answer
                          </h4>
                          <MarkdownBlock value={flaw.goldenAnswer || flaw.expectedIdentification} />
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
                      <MarkdownBlock value={exercise.debrief.raw} />
                    </div>
                  </Panel>

                  <Panel className="overflow-hidden bg-panel/70">
                    <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                      <MessageSquare className="h-4 w-4 text-accent" />
                      <h3 className="text-sm font-semibold">Discussion</h3>
                    </div>
                    <div className="max-h-72 space-y-3 overflow-auto p-4 scrollbar-thin">
                      {currentProgress.chat.length === 0 ? (
                        <p className="text-sm text-muted">Ask about your submitted review, missed reasoning, or better implementation shape.</p>
                      ) : (
                        currentProgress.chat.map((message) => (
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
                    <div className="border-t border-line p-3">
                      <Textarea
                        aria-label="Discussion message"
                        name={`${exercise.id}-discussion-message`}
                        autoComplete="off"
                        className="min-h-24"
                        value={chatDraft}
                        placeholder="Ask a follow-up after submission…"
                        onChange={(event) => setChatDraft(event.target.value)}
                      />
                      <Button className="mt-2 w-full" onClick={sendChat} disabled={chatSending || !chatDraft.trim()}>
                        {chatSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
                        Send
                      </Button>
                    </div>
                  </Panel>
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

function compactFileName(filePath: string) {
  const fileName = filePath.split("/").pop() ?? filePath;
  const withoutExtension = fileName.replace(/\.(tsx?|jsx?|json|md|sql|prisma)$/, "");
  return withoutExtension.length > 14 ? `${withoutExtension.slice(0, 12)}...` : withoutExtension;
}

function UnifiedDiff({
  file,
  activeRefs,
  onToggle,
}: {
  file: DiffFile;
  activeRefs: string[];
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
            return (
              <button
                key={`${hunk.header}-${index}`}
                className={cn(
                  "content-visibility-auto grid min-h-6 w-full grid-cols-[64px_64px_1fr] text-left transition-[background-color]",
                  line.type === "add" && "bg-success/10",
                  line.type === "delete" && "bg-danger/10",
                  selected && "bg-accent/15"
                )}
                onClick={() => onToggle(file, line)}
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
                  {line.content}
                </code>
              </button>
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
  onToggle,
}: {
  file: DiffFile;
  activeRefs: string[];
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
            const oldContent = line.type === "add" ? "" : line.content;
            const newContent = line.type === "delete" ? "" : line.content;
            return (
              <button
                key={`${hunk.header}-${index}`}
                className={cn(
                  "content-visibility-auto grid min-h-6 w-full grid-cols-[64px_minmax(0,1fr)_64px_minmax(0,1fr)] text-left transition-[background-color]",
                  selected && "bg-accent/15"
                )}
                onClick={() => onToggle(file, line)}
              >
                <span className="select-none border-r border-line/70 px-2 text-right text-muted tabular-nums">
                  {line.oldLine ?? ""}
                </span>
                <code className={cn("whitespace-pre border-r border-line/70 px-3", line.type === "delete" && "bg-danger/10 text-danger")}>
                  {oldContent}
                </code>
                <span className="select-none border-r border-line/70 px-2 text-right text-muted tabular-nums">
                  {line.newLine ?? ""}
                </span>
                <code className={cn("whitespace-pre px-3", line.type === "add" && "bg-success/10 text-success")}>
                  {newContent}
                </code>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
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
