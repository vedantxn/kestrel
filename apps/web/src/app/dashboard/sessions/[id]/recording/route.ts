import { recordingResponse } from "@kestrel/dashboard/lib/routes";
import { clientFor, readSession } from "@/lib/auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await readSession();
  if (!session) return Response.redirect(new URL("/login", req.url), 303);
  return recordingResponse(clientFor(session.apiKey), (await params).id);
}
