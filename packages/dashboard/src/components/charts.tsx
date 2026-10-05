"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@kestrel/dashboard/components/ui/chart";
import { formatDay } from "@kestrel/dashboard/lib/format";

/**
 * One measure per day, one series, so no legend: the card's title names it. Bars meet the
 * baseline square and round at the data end; the grid stays recessive; hover shows the value.
 */
export function DailyBars({
  data,
  label,
  unit,
}: {
  data: { date: string; value: number }[];
  label: string;
  unit?: string;
}) {
  const config = {
    value: { label, color: "var(--chart-1)" },
  } satisfies ChartConfig;
  const fmt = (v: number) =>
    `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit ? ` ${unit}` : ""}`;
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <BarChart
        data={data}
        margin={{ left: 0, right: 4, top: 8 }}
        barCategoryGap={data.length > 40 ? 1 : 3}
      >
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatDay}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          allowDecimals={false}
          tickFormatter={(v: number) =>
            v.toLocaleString("en-US", { notation: "compact" })
          }
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={
            <ChartTooltipContent
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
        <Bar
          dataKey="value"
          fill="var(--color-value)"
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
        />
      </BarChart>
    </ChartContainer>
  );
}
