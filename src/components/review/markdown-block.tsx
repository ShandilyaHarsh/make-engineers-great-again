import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function MarkdownBlock({
  value,
  className,
  renderInline,
}: {
  value: string;
  className?: string;
  renderInline?: (value: string) => ReactNode;
}) {
  const blocks = value
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return (
    <div className={cn("space-y-3 text-sm leading-6 text-ink", className)}>
      {blocks.map((block, index) => {
        const inlineRenderer = renderInline ?? inline;

        if (block.startsWith("- ")) {
          return (
            <ul key={index} className="space-y-1 pl-4">
              {block.split("\n").map((line, itemIndex) => (
                <li key={itemIndex} className="list-disc text-pretty">
                  {inlineRenderer(line.replace(/^-\s+/, ""))}
                </li>
              ))}
            </ul>
          );
        }

        if (/^\d+\.\s/.test(block)) {
          return (
            <ol key={index} className="space-y-1 pl-4">
              {block.split("\n").map((line, itemIndex) => (
                <li key={itemIndex} className="list-decimal text-pretty">
                  {inlineRenderer(line.replace(/^\d+\.\s+/, ""))}
                </li>
              ))}
            </ol>
          );
        }

        if (block.startsWith("### ")) {
          return (
            <h3 key={index} className="pt-2 text-sm font-semibold text-ink text-balance">
              {block.replace(/^###\s+/, "")}
            </h3>
          );
        }

        return (
          <p key={index} className="text-pretty text-muted">
            {inlineRenderer(block)}
          </p>
        );
      })}
    </div>
  );
}

function inline(value: string) {
  const parts = value.split(/(`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={index} className="rounded bg-panel px-1 py-0.5 font-mono text-[0.92em] text-ink">
          {part.slice(1, -1)}
        </code>
      );
    }

    return <span key={index}>{part}</span>;
  });
}
