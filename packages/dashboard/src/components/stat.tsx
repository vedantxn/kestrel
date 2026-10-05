import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@kestrel/dashboard/components/ui/card";
import { NumberTicker } from "@kestrel/dashboard/components/ui/number-ticker";

/** A headline number: the label names it, the number is the largest thing on the card. */
export function Stat({
  label,
  value,
  decimals = 0,
  unit,
  hint,
  icon: Icon,
}: {
  label: string;
  value: number;
  decimals?: number;
  unit?: string;
  hint?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <Card className="gap-2 py-5">
      <CardHeader className="flex flex-row items-center justify-between px-5">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent className="px-5">
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-semibold tracking-tight tabular-nums">
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
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
