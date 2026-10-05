"use client";

import { ArrowRight, KeyRound } from "lucide-react";
import { useActionState, type ReactNode } from "react";
import { LogoMark } from "@kestrel/dashboard/components/logo";
import { AnimatedShinyText } from "@kestrel/dashboard/components/ui/animated-shiny-text";
import { BackgroundBeams } from "@kestrel/dashboard/components/ui/background-beams";
import { BorderBeam } from "@kestrel/dashboard/components/ui/border-beam";
import { Button } from "@kestrel/dashboard/components/ui/button";
import { Input } from "@kestrel/dashboard/components/ui/input";
import { Label } from "@kestrel/dashboard/components/ui/label";

export type LoginState = { error?: string } | undefined;

/** The frame every sign-in page shares: logo, beams behind, a card with a moving border. */
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
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden bg-background px-4">
      <BackgroundBeams className="opacity-60" />
      <div className="relative z-10 w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <LogoMark className="size-11" />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <AnimatedShinyText className="text-sm">
              {subtitle}
            </AnimatedShinyText>
          </div>
        </div>
        <div className="relative overflow-hidden rounded-xl border bg-card/80 p-6 shadow-xl backdrop-blur">
          {children}
          <BorderBeam
            size={90}
            duration={9}
            colorFrom="var(--primary)"
            colorTo="var(--chart-3)"
          />
        </div>
        {footer && (
          <div className="mt-6 text-center text-xs text-muted-foreground">
            {footer}
          </div>
        )}
      </div>
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
    <form action={formAction} className="grid gap-4">
      {notice && !state?.error && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
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
            className="pl-9 font-mono"
            required
            autoFocus
          />
        </div>
        {state?.error && (
          <p role="alert" className="text-xs text-destructive">
            {state.error}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Checking" : "Continue"} <ArrowRight />
      </Button>
    </form>
  );
}
