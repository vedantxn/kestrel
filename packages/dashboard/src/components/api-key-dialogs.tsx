"use client";

import type { CreatedApiKey } from "@kestrel/contracts";
import { KeyRound, Plus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CopyButton } from "@kestrel/dashboard/components/copy-button";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@kestrel/dashboard/components/ui/dialog";
import { Input } from "@kestrel/dashboard/components/ui/input";
import { Label } from "@kestrel/dashboard/components/ui/label";
import type { ActionResult } from "@kestrel/dashboard/lib/actions";

export function CreateKeyDialog({
  create,
}: {
  /** A server action. */
  create: (name: string) => Promise<ActionResult<CreatedApiKey>>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [pending, start] = useTransition();

  const close = (o: boolean) => {
    setOpen(o);
    if (!o) {
      // The key is gone from the page once the dialog closes; it cannot be shown again.
      setCreated(null);
      setName("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New key
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy your new key</DialogTitle>
              <DialogDescription>
                This is the only time it is shown. Only a hash is kept, so it
                cannot be recovered.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">
                {created.key}
              </code>
              <CopyButton value={created.key} label="Copy key" />
            </div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <TriangleAlert className="size-3.5 text-warning" />
              Anyone with this key controls this project&apos;s browsers.
            </p>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await create(name);
                if (!r.ok) return void toast.error(r.error);
                setCreated(r.value);
                router.refresh();
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Name it after where it will be used, so you know what breaks if
                you revoke it.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                placeholder="production agents"
                value={name}
                maxLength={64}
                required
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending || !name.trim()}>
                <KeyRound /> {pending ? "Creating" : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RevokeKeyButton({
  id,
  name,
  revoke,
}: {
  id: string;
  name: string;
  /** A server action. */
  revoke: (id: string) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-destructive hover:text-destructive"
        >
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It stops working at once, everywhere it is used. Running sessions
            keep running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              start(async () => {
                const r = await revoke(id);
                if (r.ok) toast.success("Key revoked");
                else toast.error(r.error);
                router.refresh();
              })
            }
          >
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
