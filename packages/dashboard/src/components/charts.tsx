"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@kestrel/dashboard/components/ui/chart";
import { formatDay } from "@kestrel/dashboard/lib/format";

/**
 * One measure per day, one series, so no legend: the card's title names it. A 2px line over a
 * soft fill, a recessive grid, and a crosshair with the value on hover.
 */
export function DailyChart({
  data,
  label,
  unit,
  height = "h-64",
}: {
  data: { date: string; value: number }[];
  label: string;
  unit?: string;
  height?: string;
}) {
  const gid = useId().replace(/:/g, "");
  const config = {
    value: { label, color: "var(--chart-1)" },
  } satisfies ChartConfig;
  const fmt = (v: number) =>
    `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit ? ` ${unit}` : ""}`;
  return (
    <ChartContainer config={config} className={`aspect-auto w-full ${height}`}>
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--color-value)"
              stopOpacity={0.32}
            />
            <stop
              offset="100%"
              stopColor="var(--color-value)"
              stopOpacity={0}
            />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeOpacity={0.5} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          minTickGap={32}
          tickFormatter={formatDay}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={36}
          allowDecimals={false}
          tickFormatter={(v: number) =>
            v.toLocaleString("en-US", { notation: "compact" })
          }
        />
        <ChartTooltip
          cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(d) => formatDay(String(d))}
              formatter={(v) => (
                <span className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono font-medium tabular-nums">
                    {fmt(Number(v))}
                  </span>
                </span>
              )}
            />
          }
        />
        <Area
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill={`url(#${gid})`}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }}
        />
      </AreaChart>
    </ChartContainer>
  );
}
