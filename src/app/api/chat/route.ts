import { NextResponse } from "next/server";
import type { ChatMessage, Exercise } from "@/lib/types";

export const runtime = "nodejs";

type ChatRequest = {
  exercise: Pick<Exercise, "id" | "title" | "flaws" | "debrief" | "verdictRubric">;
  answers: Array<{
    flawId: string;
    answer: string;
    lineRefs: string[];
  }>;
  messages: ChatMessage[];
};

export async function POST(request: Request) {
  const payload = (await request.json()) as ChatRequest;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({
      message:
        "Chat is ready, but OPENAI_API_KEY is not configured. Add it on the server to discuss your submitted answer against the hidden answer key.",
      disabled: true,
    });
  }

  const model = process.env.OPENAI_CHAT_MODEL ?? process.env.OPENAI_VERIFIER_MODEL ?? "gpt-5-nano";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      instructions:
        "You are a senior engineering coach helping a learner after they submitted a PR review exercise. You may use the hidden golden answers. Be direct, specific, and focused on improving review judgment.",
      input: [
        {
          role: "user",
          content: JSON.stringify({
            exercise: payload.exercise,
            submittedAnswers: payload.answers,
            conversation: payload.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    return NextResponse.json({
      message: `Chat request failed with ${response.status}.`,
      disabled: true,
    });
  }

  const data = await response.json();
  return NextResponse.json({ message: extractOutputText(data), disabled: false });
}

function extractOutputText(data: unknown): string {
  const maybe = data as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };

  if (maybe.output_text) return maybe.output_text;

  const text = maybe.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter(Boolean)
    .join("\n");

  return text || "I could not read the model response.";
}
