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
    <nav className="inline-flex w-fit self-start overflow-x-auto rounded-lg border bg-muted/40 p-0.5 text-sm">
      {options.map((o) => (
        <Link
          key={o.value}
          href={href(o.value)}
          className={cn(
            "rounded-md px-3 py-1 text-muted-foreground transition-colors hover:text-foreground",
            o.value === value && "bg-background text-foreground shadow-sm",
          )}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}
