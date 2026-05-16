import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "min-h-36 w-full resize-y rounded-md bg-surface px-3 py-2 text-sm leading-6 text-ink shadow-[inset_0_0_0_1px_hsl(var(--line)),0_1px_2px_rgba(15,23,42,0.03)] outline-none transition-[box-shadow,background-color] duration-150 ease-[cubic-bezier(0.2,0,0,1)] placeholder:text-muted/70 focus:shadow-[inset_0_0_0_1px_hsl(var(--accent)),0_0_0_3px_hsl(var(--accent)/0.12)]",
        className
      )}
      {...props}
    />
  )
);

Textarea.displayName = "Textarea";
