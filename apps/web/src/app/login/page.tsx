import type { Metadata } from "next";
import {
  ApiKeyLoginForm,
  AuthFrame,
} from "@kestrel/dashboard/components/login-card";
import { signIn } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  const { expired } = await searchParams;
  return (
    <AuthFrame
      title="Sign in to Kestrel"
      subtitle="Cloud browsers for AI agents"
      footer={
        <>
          No key? The installer printed the admin key; on the host it is in{" "}
          <code className="font-mono">
            /var/lib/kestrel/secrets/owner-api-key
          </code>
        </>
      }
    >
      <ApiKeyLoginForm
        action={signIn}
        notice={
          expired
            ? "Your key stopped working (revoked?). Sign in with another."
            : undefined
        }
      />
    </AuthFrame>
  );
}
