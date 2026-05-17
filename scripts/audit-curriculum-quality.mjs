import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_DIR = path.join(ROOT, "curriculum", "exercises");
const HEADING_RE = /^##\s+/gm;

const directAnswerHintPatterns = [
  /dangerous (?:code|query)/i,
  /\bthe bug is\b/i,
  /\bthe flaw is\b/i,
  /\bthe missing test is\b/i,
  /\bblessing the bug\b/i,
  /\blocking in the bug\b/i,
  /\bnever mentions\b/i,
  /\bthere is none\b/i,
  /\bno unique constraint\b/i,
  /\bmissing [`A-Za-z_]/i,
  /\bdoes not include\b/i,
  /\bdoesn't include\b/i,
];

const shallowFlawTitlePatterns = [
  /\bsyntax\b/i,
  /\btypo\b/i,
  /\blint\b/i,
  /\bformatting\b/i,
  /\bwon't run\b/i,
  /\bwill not run\b/i,
  /\bfails to compile\b/i,
  /\bcompile error\b/i,
  /\btype error\b/i,
  /\bmissing import\b/i,
  /\bunused variable\b/i,
];

const directThoughtProcessPatterns = [
  /\bIn this PR\b/i,
  /\bThis PR fails\b/i,
  /\bthe degraded PR\b/i,
  /\bpoints directly\b/i,
  /\bthe helper's missing\b/i,
  /\bboth answers are (?:bad|uncomfortable)\b/i,
  /\bthe answer to both is bad\b/i,
  /\bHere,?\s+(?:it does not|there is no)\b/i,
];

function section(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) return "";

  HEADING_RE.lastIndex = start + 1;
  const next = HEADING_RE.exec(markdown);
  const end = next ? next.index : markdown.length;

  return markdown.slice(start, end).replace(`## ${heading}`, "").trim();
}

function flawSections(markdown) {
  const directMatches = [...markdown.matchAll(/^## Intended Flaw\s+(\d+):\s+(.+)$/gm)];
  if (directMatches.length > 0) {
    return directMatches.map((match, index) => {
      const start = match.index + match[0].length;
      const next = directMatches[index + 1]?.index ?? markdown.indexOf("\n## Expert Debrief", start);
      const end = next === -1 ? markdown.length : next;

      return {
        number: match[1],
        title: match[2].trim(),
        body: markdown.slice(start, end).trim(),
      };
    });
  }

  const intended = section(markdown, "Intended Flaws");
  const legacyMatches = [...intended.matchAll(/^### Flaw\s+(\d+):\s+(.+)$/gm)];

  return legacyMatches.map((match, index) => {
    const start = match.index + match[0].length;
    const next = legacyMatches[index + 1]?.index ?? intended.length;

    return {
      number: match[1],
      title: match[2].trim(),
      body: intended.slice(start, next).trim(),
    };
  });
}

function extractHints(body) {
  const directHints = [...body.matchAll(/(?:^|\n)### Hint\s+(\d+)\s*\n([\s\S]*?)(?=\n### |\n## |\n?$)/g)];
  if (directHints.length > 0) {
    return directHints.map((match) => ({
      number: match[1],
      text: normalize(match[2]),
    }));
  }

  const hintsBlock = body.includes("Hints:") ? body.split("Hints:").slice(1).join("Hints:") : "";

  return hintsBlock
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\.\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      number: match[1],
      text: normalize(match[2]),
    }));
}

function reviewerThoughtProcessSections(markdown) {
  const sections = [];
  const headingMatches = [...markdown.matchAll(/^### Reviewer [Tt]hought [Pp]rocess\s*\n([\s\S]*?)(?=\n### |\n## |\n?$)/gm)];

  for (const match of headingMatches) {
    sections.push(normalize(match[1]));
  }

  const inlineMatches = [
    ...markdown.matchAll(
      /(?:^|\n)Reviewer thought process:\s*([\s\S]*?)(?=\n\n(?:Better implementation direction|## Correctness|###|##)|\n## |\n?$)/gi,
    ),
  ];

  for (const match of inlineMatches) {
    sections.push(normalize(match[1]));
  }

  return sections;
}

function normalize(value) {
  return value.trim().replace(/\s+/g, " ");
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

const files = (await readdir(SOURCE_DIR)).filter((file) => /^TS-\d+.*\.md$/.test(file)).sort();
const findings = [];
let flawCount = 0;
let hintCount = 0;

for (const fileName of files) {
  const markdown = await readFile(path.join(SOURCE_DIR, fileName), "utf8");
  const flaws = flawSections(markdown);
  flawCount += flaws.length;

  for (const thoughtProcess of reviewerThoughtProcessSections(markdown)) {
    if (matchesAny(thoughtProcess, directThoughtProcessPatterns)) {
      findings.push(`${fileName}: answer-forward reviewer thought process: ${thoughtProcess}`);
    }
  }

  for (const flaw of flaws) {
    if (matchesAny(flaw.title, shallowFlawTitlePatterns)) {
      findings.push(`${fileName} flaw ${flaw.number}: shallow flaw title: ${flaw.title}`);
    }

    for (const hint of extractHints(flaw.body)) {
      hintCount += 1;
      if (matchesAny(hint.text, directAnswerHintPatterns)) {
        findings.push(`${fileName} flaw ${flaw.number} hint ${hint.number}: answer-leaking hint: ${hint.text}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  console.error(`\nCurriculum audit failed with ${findings.length} finding(s).`);
  process.exit(1);
}

console.log(`Curriculum audit passed: ${files.length} exercises, ${flawCount} flaws, ${hintCount} hints.`);
