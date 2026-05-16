import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_DIR = path.join(ROOT, "curriculum", "exercises");
const OUT_DIR = path.join(ROOT, "public", "exercises");

const HEADING_RE = /^##\s+/gm;

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripMd(input) {
  return input
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function parseMetadata(markdown) {
  const metaSection = section(markdown, "Metadata");
  const metadata = {};

  for (const line of metaSection.split("\n")) {
    const match = line.match(/^-\s+`([^`]+)`:\s+(.+)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const link = rawValue.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (link) {
      metadata[key] = { label: link[1], url: link[2] };
      continue;
    }

    const cleaned = rawValue.trim();
    const numeric = Number(cleaned.replace(/,/g, ""));
    metadata[key] = Number.isFinite(numeric) && /^\d[\d,]*$/.test(cleaned) ? numeric : cleaned;
  }

  return metadata;
}

function section(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) return "";
  HEADING_RE.lastIndex = start + 1;
  const next = HEADING_RE.exec(markdown);
  const end = next ? next.index : markdown.length;
  return markdown.slice(start, end).replace(`## ${heading}`, "").trim();
}

function sectionByRegex(markdown, regex) {
  const match = regex.exec(markdown);
  if (!match) return "";
  const start = match.index;
  HEADING_RE.lastIndex = start + 1;
  const next = HEADING_RE.exec(markdown);
  const end = next ? next.index : markdown.length;
  return markdown.slice(start, end).replace(match[0], "").trim();
}

function extractDiff(markdown) {
  const match = markdown.match(/```diff\n([\s\S]*?)\n```/);
  return match?.[1] ?? "";
}

function parseReviewSurface(markdown) {
  const reviewSurface = section(markdown, "Review Surface");
  return reviewSurface
    .split("\n")
    .map((line) => line.match(/^-\s+`([^`]+)`/)?.[1])
    .filter(Boolean);
}

function parseDiff(rawDiff) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawDiff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = {
        oldPath: fileMatch[1],
        newPath: fileMatch[2],
        language: languageForPath(fileMatch[2]),
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      currentHunk = {
        header: line,
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentFile.additions += 1;
      currentHunk.lines.push({
        id: `${currentFile.newPath}:${newLine}`,
        type: "add",
        oldLine: null,
        newLine,
        content: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      currentFile.deletions += 1;
      currentHunk.lines.push({
        id: `${currentFile.newPath}:old-${oldLine}`,
        type: "delete",
        oldLine,
        newLine: null,
        content: line.slice(1),
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      currentHunk.lines.push({
        id: `${currentFile.newPath}:${newLine}`,
        type: "context",
        oldLine,
        newLine,
        content: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files;
}

function languageForPath(filePath) {
  const ext = path.extname(filePath).replace(".", "");
  return (
    {
      ts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      json: "json",
      md: "markdown",
      sql: "sql",
      prisma: "prisma",
    }[ext] ?? "text"
  );
}

function parseFlaws(markdown, metadata) {
  const direct = parseDirectFlawSections(markdown);
  if (direct.length > 0) return direct;

  const intended = section(markdown, "Intended Flaws");
  let flawSource = intended;
  let flawMatches = [...flawSource.matchAll(/^### Flaw\s+(\d+):\s+(.+)$/gm)];

  if (flawMatches.length === 0) {
    flawSource = section(markdown, "Expected Answer") || section(markdown, "Golden Answer Summary");
    flawMatches = [...flawSource.matchAll(/^### Flaw\s+(\d+):\s+(.+)$/gm)];
  }

  const flaws = flawMatches.map((match, index) => {
    const start = match.index + match[0].length;
    const next = flawMatches[index + 1]?.index ?? flawSource.length;
    const body = flawSource.slice(start, next).trim();
    return parseLegacyFlaw(match[1], match[2], body);
  });

  if (flaws.length === 0) return fallbackFlaws(metadata.flaw_count ?? 2);

  attachSeparateHintSections(markdown, flaws);
  attachExpectedAnswerSection(markdown, flaws);

  return flaws;
}

function parseDirectFlawSections(markdown) {
  const matches = [...markdown.matchAll(/^## Intended Flaw\s+(\d+):\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const next = matches[index + 1]?.index ?? markdown.indexOf("\n## Expert Debrief", start);
    const end = next === -1 ? markdown.length : next;
    const body = markdown.slice(start, end).trim();
    return {
      id: `flaw-${match[1]}`,
      number: Number(match[1]),
      title: match[2].trim(),
      prompt: extractSubsection(body, "Expected Identification") || match[2].trim(),
      expectedIdentification: extractSubsection(body, "Expected Identification"),
      expectedImpact: extractSubsection(body, "Expected Impact"),
      expectedFix: extractSubsection(body, "Expected Fix Direction") || extractSubsection(body, "Better Fix Direction"),
      goldenAnswer: [
        extractSubsection(body, "Expected Identification"),
        extractSubsection(body, "Expected Impact"),
        extractSubsection(body, "Expected Fix Direction") || extractSubsection(body, "Better Fix Direction"),
      ]
        .filter(Boolean)
        .join("\n\n"),
      hints: extractHints(body),
    };
  });
}

function parseLegacyFlaw(number, title, body) {
  const expected = extractBetween(body, "Expected answer:", "Hints:").trim();
  const hintsBlock =
    new RegExp(`### Flaw\\s+${number} Hints\\s*\\n([\\s\\S]*?)(?=\\n### |$)`).exec(body)?.[1] ??
    (body.includes("Hints:") ? body.split("Hints:").slice(1).join("Hints:") : "");
  const prompt = body.match(/`learner_prompt`:\s*(.+)$/m)?.[1]?.trim() ?? title.trim();

  return {
    id: `flaw-${number}`,
    number: Number(number),
    title: title.trim(),
    prompt,
    expectedIdentification: expected,
    expectedImpact: "",
    expectedFix: "",
    goldenAnswer: expected,
    hints: extractNumberedList(hintsBlock),
  };
}

function attachSeparateHintSections(markdown, flaws) {
  const hintsSection = section(markdown, "Hints") || section(markdown, "Intended Flaws");
  if (!hintsSection) return;

  for (const flaw of flaws) {
    if (flaw.hints.length >= 3) continue;
    const match = new RegExp(`### Flaw\\s+${flaw.number} Hints\\s*\\n([\\s\\S]*?)(?=\\n### |$)`).exec(
      hintsSection
    );
    if (match) flaw.hints = extractNumberedList(match[1]);
  }
}

function attachExpectedAnswerSection(markdown, flaws) {
  const expected = section(markdown, "Expected Answer") || section(markdown, "Golden Answer Summary");
  if (!expected) return;

  for (const flaw of flaws) {
    if (flaw.goldenAnswer) continue;
    const match = new RegExp(`Flaw\\s+${flaw.number}[^\\n]*\\n([\\s\\S]*?)(?=\\n-?\\s*Flaw\\s+\\d|$)`, "i").exec(
      expected
    );
    flaw.goldenAnswer = match?.[1]?.trim() || expected;
    flaw.expectedIdentification = flaw.goldenAnswer;
  }
}

function extractSubsection(body, heading) {
  const regex = new RegExp(`^### ${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n### |$)`, "m");
  return regex.exec(body)?.[1]?.trim() ?? "";
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHints(body) {
  const matches = [...body.matchAll(/(?:^|\n)### Hint\s+\d+\s*\n([\s\S]*?)(?=\n### |\n## |\n?$)/g)];
  if (matches.length > 0) return matches.map((match) => stripMd(match[1]));

  const hintsBlock = body.includes("Hints:") ? body.split("Hints:").slice(1).join("Hints:") : "";
  return extractNumberedList(hintsBlock);
}

function extractNumberedList(block) {
  return block
    .split("\n")
    .map((line) => line.match(/^\s*\d+\.\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map(stripMd);
}

function extractBetween(input, startLabel, endLabel) {
  const start = input.indexOf(startLabel);
  if (start === -1) return "";
  const afterStart = start + startLabel.length;
  const end = input.indexOf(endLabel, afterStart);
  return input.slice(afterStart, end === -1 ? input.length : end);
}

function fallbackFlaws(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `flaw-${index + 1}`,
    number: index + 1,
    title: `Flaw ${index + 1}`,
    prompt: `Describe flaw ${index + 1}.`,
    expectedIdentification: "",
    expectedImpact: "",
    expectedFix: "",
    goldenAnswer: "",
    hints: [],
  }));
}

function parseDebrief(markdown) {
  const debrief =
    sectionByRegex(markdown, /^## Final Expert Debrief$/m) ||
    sectionByRegex(markdown, /^## Expert Debrief$/m);

  return {
    raw: debrief,
    productLevelChange: extractSubsection(debrief, "Product-Level Change") || extractSubsection(debrief, "Product-level change"),
    changedContracts:
      extractSubsection(debrief, "Changed Contracts") ||
      extractSubsection(debrief, "Changed contracts") ||
      extractSubsection(debrief, "Contracts Changed"),
    failureModes: extractSubsection(debrief, "Failure Modes") || extractSubsection(debrief, "Failure modes"),
    reviewerThoughtProcess:
      extractSubsection(debrief, "Reviewer Thought Process") ||
      extractSubsection(debrief, "Reviewer thought process"),
    betterImplementation:
      extractSubsection(debrief, "Better Implementation Direction") ||
      extractSubsection(debrief, "Better implementation direction") ||
      extractSubsection(debrief, "What Good Looks Like"),
  };
}

function parseExercise(fileName, markdown) {
  const titleMatch = markdown.match(/^#\s+(TS-\d+):\s+(.+)$/m);
  const id = titleMatch?.[1] ?? fileName.match(/^(TS-\d+)/)?.[1] ?? slugify(fileName);
  const metadata = parseMetadata(markdown);
  const rawDiff = extractDiff(markdown);
  const files = parseDiff(rawDiff);
  const sourceRepo = metadata.source_repo;

  return {
    id,
    slug: fileName.replace(/\.md$/, ""),
    title: titleMatch?.[2] ?? id,
    sourceFile: `curriculum/exercises/${fileName}`,
    sourceRepo:
      typeof sourceRepo === "object"
        ? sourceRepo
        : {
            label: String(sourceRepo ?? ""),
            url: "",
          },
    repoArea: metadata.repo_area ?? "",
    difficulty: Number(metadata.difficulty ?? 1),
    targetDiffLines: metadata.target_diff_lines ?? "",
    representedDiffLines: Number(metadata.represented_diff_lines ?? rawDiff.split("\n").length),
    mode: metadata.mode ?? "synthetic_degraded",
    prDescription: section(markdown, "PR Description Shown To Learner"),
    existingCodeContext: section(markdown, "Existing Code Context"),
    learnerTask: section(markdown, "Learner Task"),
    reviewSurface: parseReviewSurface(markdown),
    diff: {
      raw: rawDiff,
      files,
      fileCount: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    flaws: parseFlaws(markdown, metadata),
    debrief: parseDebrief(markdown),
    verdictRubric: section(markdown, "Correctness Verdict Rubric") || sectionByRegex(markdown, /^### Correctness Verdict$/m),
  };
}

const files = (await readdir(SOURCE_DIR))
  .filter((file) => /^TS-\d+.*\.md$/.test(file))
  .sort((a, b) => a.localeCompare(b));

await mkdir(OUT_DIR, { recursive: true });

const exercises = [];
for (const file of files) {
  const markdown = await readFile(path.join(SOURCE_DIR, file), "utf8");
  const exercise = parseExercise(file, markdown);
  exercises.push({
    id: exercise.id,
    slug: exercise.slug,
    title: exercise.title,
    sourceRepo: exercise.sourceRepo,
    difficulty: exercise.difficulty,
    representedDiffLines: exercise.representedDiffLines,
    flawCount: exercise.flaws.length,
    fileName: `${exercise.id}.json`,
  });
  await writeFile(path.join(OUT_DIR, `${exercise.id}.json`), `${JSON.stringify(exercise, null, 2)}\n`);
}

await writeFile(
  path.join(OUT_DIR, "index.json"),
  `${JSON.stringify(
    {
      generatedAt: "static",
      count: exercises.length,
      exercises,
    },
    null,
    2
  )}\n`
);

console.log(`Generated ${exercises.length} structured exercises in ${path.relative(ROOT, OUT_DIR)}`);
