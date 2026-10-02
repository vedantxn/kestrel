import type { z } from "zod";

/** One zod-validated environment module per app: fail at startup, naming every bad variable. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const r = schema.safeParse(env);
  if (r.success) return r.data;
  const lines = r.error.issues.map(
    (i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`,
  );
  throw new Error(`invalid environment:\n${lines.join("\n")}`);
}
