"use client";

import { ChevronRight, Moon, Search, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import type { NavItem } from "@kestrel/dashboard/components/shell";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@kestrel/dashboard/components/ui/command";
import { Kbd } from "@kestrel/dashboard/components/ui/kbd";

const SESSION_ID = /^ses_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** ⌘K: jump to any page, open a session by its id, switch the theme. */
export function CommandMenu({
  items,
  base,
}: {
  items: NavItem[];
  base: string;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };
  const id = query.trim();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full max-w-72 items-center gap-2 border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Jump to…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Jump to">
        <CommandInput
          placeholder="Search pages, or paste a session id"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {SESSION_ID.test(id) && (
            <CommandGroup heading="Session">
              <CommandItem
                value={id}
                onSelect={() => go(`${base}/sessions/${id}`)}
              >
                <ChevronRight /> Open <span className="font-mono">{id}</span>
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading="Pages">
            {items.map((item) => (
              <CommandItem key={item.href} onSelect={() => go(item.href)}>
                <item.icon /> {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Theme">
            <CommandItem onSelect={() => (setTheme("dark"), setOpen(false))}>
              <Moon /> Dark
            </CommandItem>
            <CommandItem onSelect={() => (setTheme("light"), setOpen(false))}>
              <Sun /> Light
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
