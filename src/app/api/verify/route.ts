import { NextResponse } from "next/server";
import type { ExerciseFlaw, Verdict, VerifyResponse } from "@/lib/types";

export const runtime = "nodejs";

type VerifyRequest = {
  exercise: {
    id: string;
    title: string;
    flaws: ExerciseFlaw[];
    debrief?: { raw: string };
    verdictRubric?: string;
  };
  answers: Array<{
    flawId: string;
    answer: string;
    lineRefs: string[];
  }>;
};

const verifierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts", "overallVerdict", "overallRationale"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["flawId", "verdict", "rationale"],
        properties: {
          flawId: { type: "string" },
          verdict: { type: "string", enum: ["correct", "partially_correct", "missed"] },
          rationale: { type: "string" },
        },
      },
    },
    overallVerdict: { type: "string", enum: ["correct", "partially_correct", "missed"] },
    overallRationale: { type: "string" },
  },
};

export async function POST(request: Request) {
  const payload = (await request.json()) as VerifyRequest;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(unverifiedResponse(payload));
  }

  const model = process.env.OPENAI_VERIFIER_MODEL ?? "gpt-5-nano";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      instructions:
        "You are grading a training exercise, not an interview. Compare each learner answer against the matching golden flaw independently. Be generous to equivalent wording, but require the learner to identify the core flawed decision, production impact, and better fix direction.",
      input: [
        {
          role: "user",
          content: JSON.stringify({
            exerciseId: payload.exercise.id,
            title: payload.exercise.title,
            flaws: payload.exercise.flaws.map((flaw) => ({
              flawId: flaw.id,
              title: flaw.title,
              goldenAnswer: flaw.goldenAnswer,
              expectedIdentification: flaw.expectedIdentification,
              expectedImpact: flaw.expectedImpact,
              expectedFix: flaw.expectedFix,
            })),
            learnerAnswers: payload.answers,
            rubric: payload.exercise.verdictRubric,
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "pr_review_training_verdict",
          strict: true,
          schema: verifierSchema,
        },
      },
    }),
  });

  if (!response.ok) {
    return NextResponse.json(unverifiedResponse(payload, `Verifier failed: ${response.status}`), {
      status: 200,
    });
  }

  const data = await response.json();
  const output = extractOutputText(data);
  const parsed = JSON.parse(output) as Omit<VerifyResponse, "mode">;

  return NextResponse.json({
    mode: "model",
    ...parsed,
  } satisfies VerifyResponse);
}

function unverifiedResponse(payload: VerifyRequest, reason = "OPENAI_API_KEY is not configured") {
  const verdicts = payload.exercise.flaws.map((flaw) => ({
    flawId: flaw.id,
    verdict: "unverified" as Verdict,
    rationale: `${reason}. Golden answer is available for self-review.`,
  }));

  return {
    mode: "unverified",
    verdicts,
    overallVerdict: "unverified",
    overallRationale: reason,
  } satisfies VerifyResponse;
}

function extractOutputText(data: unknown): string {
  const maybe = data as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };

  if (maybe.output_text) return maybe.output_text;

  const text = maybe.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter(Boolean)
    .join("\n");

  if (!text) throw new Error("No verifier output text");
  return text;
}
