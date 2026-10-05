import type { SessionStatus } from "@kestrel/contracts";

/** Display helpers. Everything here returns plain text; nothing is ever rendered as HTML. */

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60)
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatMinutes(seconds: number): string {
  const m = seconds / 60;
  return m < 10 ? m.toFixed(1) : Math.round(m).toLocaleString("en-US");
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "–";
  const diff = new Date(iso).getTime() - now;
  for (const [unit, ms] of UNITS)
    if (Math.abs(diff) >= ms || unit === "second")
      return rtf.format(Math.round(diff / ms), unit);
  return "–";
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** How long a session has run, or ran. */
export function sessionDuration(s: {
  createdAt: string;
  endedAt: string | null;
  readyAt: string | null;
}): number {
  const start = new Date(s.readyAt ?? s.createdAt).getTime();
  const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
  return Math.max(0, (end - start) / 1000);
}

export const LIVE_STATUSES: readonly SessionStatus[] = [
  "requested",
  "scheduling",
  "starting",
  "ready",
  "active",
  "stopping",
];

export const isLive = (s: SessionStatus) => LIVE_STATUSES.includes(s);

export const humanize = (s: string) =>
  s.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
