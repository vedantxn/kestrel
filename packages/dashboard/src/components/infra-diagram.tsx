"use client";

import { Bot, Globe } from "lucide-react";
import { useRef, type ReactNode, type RefObject } from "react";
import { LogoMark } from "@kestrel/dashboard/components/logo";
import { AnimatedBeam } from "@kestrel/dashboard/components/ui/animated-beam";
import { cn } from "@kestrel/dashboard/lib/utils";

function Node({
  ref,
  label,
  sub,
  children,
  className,
}: {
  ref: RefObject<HTMLDivElement | null>;
  label: string;
  sub?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="z-10 flex flex-col items-center gap-1.5">
      <div
        ref={ref}
        className={cn(
          "flex size-14 items-center justify-center border bg-card",
          className,
        )}
      >
        {children}
      </div>
      <span className="label-mono text-[10px]">{label}</span>
      {sub && (
        <span className="font-mono text-[10px] text-muted-foreground">
          {sub}
        </span>
      )}
    </div>
  );
}

/** How Kestrel works, as a diagram: an agent asks the API, the API hands it isolated browsers. */
export function InfraDiagram() {
  const container = useRef<HTMLDivElement>(null);
  const agent = useRef<HTMLDivElement>(null);
  const api = useRef<HTMLDivElement>(null);
  const b1 = useRef<HTMLDivElement>(null);
  const b2 = useRef<HTMLDivElement>(null);
  const b3 = useRef<HTMLDivElement>(null);
  const beam = {
    containerRef: container,
    pathColor: "var(--foreground)",
    pathOpacity: 0.22,
    pathWidth: 1.5,
    gradientStartColor: "var(--brand)",
    gradientStopColor: "var(--chart-2)",
  };
  return (
    <div
      ref={container}
      className="relative flex items-center justify-between border border-dashed bg-card/60 px-8 py-8"
    >
      <Node ref={agent} label="Your agent" sub="SDK · MCP · CDP">
        <Bot className="size-5" />
      </Node>
      <Node
        ref={api}
        label="Kestrel"
        sub="142 ms hot start"
        className="border-foreground"
      >
        <LogoMark className="size-8" />
      </Node>
      <div className="z-10 flex flex-col gap-3">
        {[b1, b2, b3].map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <div
              ref={r}
              className="flex size-10 items-center justify-center border bg-card"
            >
              <Globe className="size-4" />
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">
              chrome · ses_{["8f2a", "c41e", "9b07"][i]}
            </span>
          </div>
        ))}
      </div>
      <AnimatedBeam {...beam} fromRef={agent} toRef={api} duration={3} />
      <AnimatedBeam
        {...beam}
        fromRef={api}
        toRef={b1}
        curvature={-30}
        duration={3}
        delay={0.4}
      />
      <AnimatedBeam
        {...beam}
        fromRef={api}
        toRef={b2}
        duration={3}
        delay={0.8}
      />
      <AnimatedBeam
        {...beam}
        fromRef={api}
        toRef={b3}
        curvature={30}
        duration={3}
        delay={1.2}
      />
    </div>
  );
}
