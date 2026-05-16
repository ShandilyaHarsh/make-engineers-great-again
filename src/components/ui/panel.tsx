import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-lg bg-surface shadow-[inset_0_0_0_1px_hsl(var(--line)),0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_rgba(15,23,42,0.04)]",
        className
      )}
    >
      {children}
    </section>
  );
}
