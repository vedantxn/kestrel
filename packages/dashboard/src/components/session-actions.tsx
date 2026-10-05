"use client";

import { Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@kestrel/dashboard/components/ui/alert-dialog";
import { Button } from "@kestrel/dashboard/components/ui/button";
import type { ActionResult } from "@kestrel/dashboard/lib/actions";

export function StopButton({
  id,
  stop,
}: {
  id: string;
  /** A server action. */
  stop: (id: string) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={pending}>
          <Square className="size-3.5 fill-current" />
          {pending ? "Stopping" : "Stop"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop this session?</AlertDialogTitle>
          <AlertDialogDescription>
            The browser is closed and anything connected to it is cut off. This
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              start(async () => {
                const r = await stop(id);
                if (r.ok) toast.success("Session stopping");
                else toast.error(r.error);
                router.refresh();
              })
            }
          >
            Stop session
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
