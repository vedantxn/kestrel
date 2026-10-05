import Link from "next/link";
import { LogoMark } from "@kestrel/dashboard/components/logo";
import { Button } from "@kestrel/dashboard/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <LogoMark className="size-10 opacity-80" />
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-sm text-muted-foreground">
        Nothing here, or it belongs to another project.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard">Back to the dashboard</Link>
      </Button>
    </main>
  );
}
