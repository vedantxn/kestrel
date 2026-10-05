"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the server component around it every `ms`, while the tab is visible. */
export function AutoRefresh({ ms = 5000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, ms);
    return () => clearInterval(id);
  }, [ms, router]);
  return null;
}
