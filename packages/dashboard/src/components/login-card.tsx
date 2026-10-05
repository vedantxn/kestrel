"use client";

import { ChevronRight, KeyRound } from "lucide-react";
import { useActionState, type ReactNode } from "react";
import { InfraDiagram } from "@kestrel/dashboard/components/infra-diagram";
import { Logo } from "@kestrel/dashboard/components/logo";
import { AnimatedShinyText } from "@kestrel/dashboard/components/ui/animated-shiny-text";
import { Button } from "@kestrel/dashboard/components/ui/button";
import { GridPattern } from "@kestrel/dashboard/components/ui/grid-pattern";
import { HyperText } from "@kestrel/dashboard/components/ui/hyper-text";
import { Input } from "@kestrel/dashboard/components/ui/input";
import { Label } from "@kestrel/dashboard/components/ui/label";
import { ShineBorder } from "@kestrel/dashboard/components/ui/shine-border";
import {
  AnimatedSpan,
  Terminal,
  TypingAnimation,
} from "@kestrel/dashboard/components/ui/terminal";
import { cn } from "@kestrel/dashboard/lib/utils";

export type LoginState = { error?: string } | undefined;

const FEATURES = [
  "Isolated Chrome per session",
  "Live view and takeover",
  "Recordings and timelines",
  "Playwright · Puppeteer · MCP",
];

/** The product side of every sign-in page: what Kestrel does, shown rather than told. */
function ProductPanel() {
  return (
    <aside className="relative hidden overflow-hidden border-l bg-background lg:flex lg:flex-col lg:justify-center">
      <GridPattern
        width={48}
        height={48}
        strokeDasharray="4 3"
        squares={[
          [3, 2],
          [9, 4],
          [5, 12],
          [11, 14],
          [2, 16],
        ]}
        className="fill-brand/10 stroke-foreground/8 [mask-image:radial-gradient(640px_circle_at_center,white,transparent)]"
      />
      <div className="relative z-10 mx-auto w-full max-w-xl space-y-7 px-10">
        <div className="space-y-4">
          <span className="inline-flex border border-success/60 bg-success/8 px-2 py-1">
            <HyperText
              as="span"
              duration={900}
              className="label-mono py-0 text-[11px] font-medium"
            >
              CLOUD BROWSERS FOR AI AGENTS
            </HyperText>
          </span>
          <h2 className="text-[2.75rem] leading-[1.02] font-medium tracking-[-0.04em] text-balance">
            One API call, a real browser your agent can drive.
          </h2>
        </div>
        <InfraDiagram />
        <div className="relative">
          <ShineBorder
            borderWidth={1}
            duration={12}
            shineColor={["var(--brand)", "var(--chart-2)", "transparent"]}
          />
          <Terminal className="max-w-none rounded-none bg-card font-mono text-[12px]">
            <TypingAnimation>
              {"> const { browser } = await kestrel.connect()"}
            </TypingAnimation>
            <AnimatedSpan className="text-success">
              ✔ ses_01m463e1yj… ready in 142 ms (hot start)
            </AnimatedSpan>
            <AnimatedSpan className="text-warning">
              ! CAPTCHA detected: Cloudflare Turnstile → handed to a person
            </AnimatedSpan>
            <AnimatedSpan className="text-success">
              ✔ solved · agent continues · recording saved
            </AnimatedSpan>
          </Terminal>
        </div>
        <ul className="grid grid-cols-2 border-t border-l text-[13px]">
          {FEATURES.map((f) => (
            <li
              key={f}
              className="flex items-center gap-2 border-r border-b bg-card/70 px-3 py-2.5"
            >
              <span className="size-1.5 bg-brand" />
              {f}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/** The frame every sign-in page shares: the form on the left, the product on the right. */
export function AuthFrame({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="grid min-h-svh bg-card lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col p-6 md:p-10">
        <Logo />
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm space-y-8">
            <div className="space-y-2">
              <h1 className="text-[2rem] leading-tight font-medium tracking-[-0.03em]">
                {title}
              </h1>
              <AnimatedShinyText className="mx-0 text-sm">
                {subtitle}
              </AnimatedShinyText>
            </div>
            {children}
          </div>
        </div>
        {footer && (
          <div className="text-xs text-muted-foreground">{footer}</div>
        )}
      </div>
      <ProductPanel />
    </main>
  );
}

/** Sign in with an API key (the open-source dashboard). */
export function ApiKeyLoginForm({
  action,
  notice,
}: {
  /** A server action: checks the key, sets the session, redirects. */
  action: (state: LoginState, form: FormData) => Promise<LoginState>;
  notice?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="grid gap-5">
      {notice && !state?.error && (
        <p className="border border-warning/40 bg-warning/8 px-3 py-2 text-xs">
          {notice}
        </p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="apiKey">API key</Label>
        <div className="relative">
          <KeyRound className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="apiKey"
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ksl_…"
            className={cn(
              "h-10 pl-9 font-mono",
              state?.error && "border-destructive/60",
            )}
            required
            autoFocus
          />
        </div>
        {state?.error ? (
          <p role="alert" className="text-xs text-destructive">
            {state.error}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            It stays on this server, sealed in a cookie; your browser never sees
            it.
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="h-10 w-full">
        {pending ? "Checking" : "Continue"} <ChevronRight />
      </Button>
    </form>
  );
}
