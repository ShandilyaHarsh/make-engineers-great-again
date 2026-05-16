import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  staticPress?: boolean;
};

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink shadow-[0_1px_2px_rgba(0,0,0,0.08),0_8px_20px_rgba(37,99,235,0.18)] hover:bg-accent/95",
  secondary:
    "bg-surface text-ink shadow-[inset_0_0_0_1px_hsl(var(--line)),0_1px_2px_rgba(15,23,42,0.04)] hover:bg-panel",
  ghost: "bg-transparent text-muted hover:bg-panel hover:text-ink",
  danger:
    "bg-danger text-white shadow-[0_1px_2px_rgba(0,0,0,0.08),0_8px_20px_rgba(220,38,38,0.16)] hover:bg-danger/95",
};

const sizes: Record<ButtonSize, string> = {
  sm: "min-h-10 px-3 text-sm",
  md: "min-h-10 px-4 text-sm",
  icon: "h-10 w-10 p-0",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", staticPress, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium outline-none transition-[background-color,box-shadow,opacity,transform,color] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:ring-2 focus-visible:ring-accent/35 disabled:pointer-events-none disabled:opacity-50",
        !staticPress && "active:scale-[0.96]",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  )
);

Button.displayName = "Button";
