import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { MonoLabel } from "@kestrel/dashboard/components/mono-label";
import { Sparkline } from "@kestrel/dashboard/components/sparkline";
import { MagicCard } from "@kestrel/dashboard/components/ui/magic-card";
import { NumberTicker } from "@kestrel/dashboard/components/ui/number-ticker";
import { cn } from "@kestrel/dashboard/lib/utils";

/**
 * A headline number. The label names it, the number is the largest thing on the tile, the
 * change and the trend sit underneath; the tile lights where the pointer is.
 */
export function Stat({
  label,
  value,
  decimals = 0,
  unit,
  hint,
  icon: Icon,
  delta,
  /** Whether a rise is good (sessions) or bad (failures). */
  higherIsBetter = true,
  trend,
  live,
}: {
  label: string;
  value: number;
  decimals?: number;
  unit?: string;
  hint?: ReactNode;
  icon?: LucideIcon;
  delta?: number | null;
  higherIsBetter?: boolean;
  trend?: number[];
  live?: boolean;
}) {
  const up = (delta ?? 0) >= 0;
  const good = up === higherIsBetter;
  return (
    <MagicCard
      className="h-full"
      gradientSize={220}
      gradientColor="color-mix(in oklch, var(--brand) 8%, transparent)"
      gradientFrom="var(--brand)"
      gradientTo="var(--chart-2)"
      gradientOpacity={1}
    >
      <div className="relative z-40 flex h-full flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-muted-foreground">
            {live && (
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
            )}
            <MonoLabel>{label}</MonoLabel>
          </span>
          {Icon && (
            <span className="flex size-7 items-center justify-center border text-muted-foreground">
              <Icon className="size-3.5" />
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[2rem] leading-none font-medium tracking-[-0.03em] tabular-nums">
            {value === 0 ? (
              "0"
            ) : (
              <NumberTicker value={value} decimalPlaces={decimals} />
            )}
          </span>
          {unit && (
            <span className="text-sm text-muted-foreground">{unit}</span>
          )}
        </div>
        <div className="mt-auto flex items-end justify-between gap-3">
          <div className="min-w-0 space-y-0.5 text-xs text-muted-foreground">
            {delta != null && Number.isFinite(delta) && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-medium whitespace-nowrap",
                  good ? "text-success" : "text-destructive",
                )}
              >
                {up ? (
                  <ArrowUpRight className="size-3.5" />
                ) : (
                  <ArrowDownRight className="size-3.5" />
                )}
                {Math.abs(delta).toFixed(Math.abs(delta) < 10 ? 1 : 0)}%
                <span className="font-normal text-muted-foreground">
                  &nbsp;vs prior
                </span>
              </span>
            )}
            {hint && <p className="truncate">{hint}</p>}
          </div>
          {trend && <Sparkline values={trend} className="w-20 shrink-0" />}
        </div>
      </div>
    </MagicCard>
  );
}
