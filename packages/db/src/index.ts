import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export { Prisma, PrismaClient } from "./generated/client.js";
export type {
  ApiKey,
  IdempotencyKey,
  Node,
  Org,
  Profile,
  ProfileVersion,
  Project,
  Session,
  SessionEvent,
} from "./generated/client.js";

/** One client per process. The driver adapter owns the connection pool. */
export function createPrisma(
  connectionString: string,
  opts: { max?: number } = {},
): PrismaClient {
  const adapter = new PrismaPg({ connectionString, max: opts.max ?? 10 });
  return new PrismaClient({ adapter });
}
