"use client";

import { HyperText } from "@kestrel/dashboard/components/ui/hyper-text";
import { cn } from "@kestrel/dashboard/lib/utils";

/** An uppercase mono label that scrambles in once when seen, and again on hover (Magic UI). */
export function MonoLabel({
  children,
  as = "span",
  className,
}: {
  children: string;
  as?: "span" | "h2" | "h3" | "p";
  className?: string;
}) {
  return (
    <HyperText
      as={as}
      startOnView
      animateOnHover
      duration={600}
      className={cn(
        "py-0 font-mono text-[11px] leading-none font-medium tracking-[0.06em] uppercase",
        className,
      )}
    >
      {children.toUpperCase()}
    </HyperText>
  );
}
