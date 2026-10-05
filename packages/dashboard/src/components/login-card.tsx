"use client";

import {
  ArrowRight,
  KeyRound,
  MonitorPlay,
  ShieldCheck,
  Video,
  Workflow,
} from "lucide-react";
import { useActionState, type ReactNode } from "react";
import { Logo } from "@kestrel/dashboard/components/logo";
import { AnimatedShinyText } from "@kestrel/dashboard/components/ui/animated-shiny-text";
import { Button } from "@kestrel/dashboard/components/ui/button";
import { DotPattern } from "@kestrel/dashboard/components/ui/dot-pattern";
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
  { icon: ShieldCheck, text: "A fresh, isolated Chrome for every session" },
  {
    icon: MonitorPlay,
    text: "Watch live, or take control when a CAPTCHA appears",
  },
  { icon: Video, text: "Recordings and a full event timeline" },
  { icon: Workflow, text: "Playwright, Puppeteer, the SDKs or MCP" },
];

/** The product side of every sign-in page: what Kestrel does, shown rather than told. */
function ProductPanel() {
  return (
    <aside className="relative hidden overflow-hidden border-l bg-sidebar lg:flex lg:flex-col lg:justify-center">
      <DotPattern
        width={22}
        height={22}
        cr={1}
        className="text-foreground/15 [mask-image:radial-gradient(520px_circle_at_center,white,transparent)]"
      />
      <div className="pointer-events-none absolute -top-40 -right-40 size-[520px] rounded-full bg-primary/20 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-48 -left-32 size-[420px] rounded-full bg-chart-3/15 blur-[120px]" />
      <div className="relative z-10 mx-auto w-full max-w-lg space-y-8 px-10">
        <div className="space-y-3">
          <p className="text-xs font-medium tracking-widest text-primary uppercase">
            Cloud browsers for AI agents
          </p>
          <h2 className="text-3xl leading-tight font-semibold tracking-tight text-balance">
            One API call, a real browser your agent can drive.
          </h2>
        </div>
        <div className="relative rounded-xl">
          <ShineBorder
            borderWidth={1}
            duration={12}
            shineColor={["var(--primary)", "var(--chart-3)", "transparent"]}
          />
          <Terminal className="max-w-none border-border/60 bg-background/70 font-mono text-[12.5px] backdrop-blur">
            <TypingAnimation>
              {"> const { browser } = await kestrel.connect()"}
            </TypingAnimation>
            <AnimatedSpan className="text-success">
              ✔ ses_01m463e1yj… ready in 142 ms (hot start)
            </AnimatedSpan>
            <TypingAnimation>
              {'> await page.goto("https://example.com/checkout")'}
            </TypingAnimation>
            <AnimatedSpan className="text-warning">
              ! CAPTCHA detected: Cloudflare Turnstile
            </AnimatedSpan>
            <AnimatedSpan className="text-muted-foreground">
              → live view link sent; a person takes over
            </AnimatedSpan>
            <AnimatedSpan className="text-success">
              ✔ solved, agent continues · recording saved
            </AnimatedSpan>
          </Terminal>
        </div>
        <ul className="grid gap-3 text-sm text-muted-foreground">
          {FEATURES.map((f) => (
            <li key={f.text} className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-md border bg-background/60">
                <f.icon className="size-3.5 text-foreground" />
              </span>
              {f.text}
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
    <main className="grid min-h-svh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col p-6 md:p-10">
        <Logo />
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm space-y-8">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
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
        <p className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs">
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
        {pending ? "Checking" : "Continue"} <ArrowRight />
      </Button>
    </form>
  );
}
