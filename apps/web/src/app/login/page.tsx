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
          No key? On the host, run{" "}
          <code className="font-mono">
            npm run admin -w @kestrel/api -- create-key
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
