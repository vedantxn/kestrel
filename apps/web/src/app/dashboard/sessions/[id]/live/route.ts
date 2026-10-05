import { liveViewResponse } from "@kestrel/dashboard/lib/routes";
import { clientFor, readSession } from "@/lib/auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await readSession();
  if (!session) return Response.redirect(new URL("/login", req.url), 303);
  const control = new URL(req.url).searchParams.get("control") === "1";
  return liveViewResponse(
    clientFor(session.apiKey),
    (await params).id,
    control,
  );
}
