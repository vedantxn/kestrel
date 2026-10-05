import Link from "next/link";
import { cn } from "@kestrel/dashboard/lib/utils";

/** A row of links that behave as one choice (filters, ranges); the choice lives in the URL. */
export function Segmented({
  options,
  value,
  href,
}: {
  options: readonly { label: string; value: string }[];
  value: string;
  href: (v: string) => string;
}) {
  return (
    <nav className="inline-flex w-fit self-start overflow-x-auto border bg-card">
      {options.map((o) => (
        <Link
          key={o.value}
          href={href(o.value)}
          className={cn(
            "border-r px-3.5 py-1.5 font-mono text-[11px] tracking-[0.06em] text-muted-foreground uppercase transition-colors last:border-r-0 hover:text-foreground",
            o.value === value &&
              "bg-foreground text-background hover:text-background",
          )}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}
