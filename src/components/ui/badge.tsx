import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type BadgeProps = {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "accent";
  className?: string;
};

const tones = {
  neutral: "bg-panel text-muted shadow-[inset_0_0_0_1px_hsl(var(--line))]",
  success: "bg-success/10 text-success shadow-[inset_0_0_0_1px_hsl(var(--success)/0.18)]",
  warning: "bg-warning/10 text-warning shadow-[inset_0_0_0_1px_hsl(var(--warning)/0.2)]",
  danger: "bg-danger/10 text-danger shadow-[inset_0_0_0_1px_hsl(var(--danger)/0.18)]",
  accent: "bg-accent/10 text-accent shadow-[inset_0_0_0_1px_hsl(var(--accent)/0.18)]",
};

export function Badge({ children, tone = "neutral", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium capitalize tabular-nums",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
