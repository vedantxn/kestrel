import { Readable } from "node:stream";
import {
  AdminCreateOrgRequest,
  AdminCreateProjectRequest,
  CreateApiKeyRequest,
  CreateProfileRequest,
  ListProfilesQuery,
  CreateSessionRequest,
  UsageQuery,
  HeartbeatRequest,
  ListEventsQuery,
  ComputerRequest,
  ListSessionsQuery,
  MintTokenRequest,
  RegisterRequest,
  ReportsRequest,
  buildOpenApiDocument,
  errorResponse,
  NODE_PATHS,
} from "@kestrel/contracts";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { z } from "zod";
import { authenticate, safeEqual } from "./auth.js";
import type { Auth, Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { newRequestId } from "./ids.js";
import { LIVE_PAGE, livePageHeaders } from "./live-page.js";
import { registerMcp, type McpOptions } from "./mcp.js";
import { heartbeat, ingestReports, registerNode } from "./nodes.js";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
} from "./profiles.js";
import {
  adminCreateApiKey,
  adminCreateOrg,
  adminCreateProject,
  createProjectApiKey,
  getProject,
  getUsage,
  listApiKeys,
  listNodes,
  requireAdmin,
  revokeApiKey,
} from "./project.js";
import {
  createSession,
  getSession,
  listEvents,
  listSessions,
  mintSessionToken,
  sessionComputer,
  sessionRecording,
  stopSession,
} from "./sessions.js";
import type { Sweeper } from "./sweeper.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: Auth;
  }
}

class ValidationFailure extends Error {
  constructor(readonly error: z.ZodError) {
    super("validation failed");
  }
}

/** A4: an unknown option is `invalid_request` naming it, never silently ignored. */
function describeIssue(error: z.ZodError): { message: string; param?: string } {
  const issue = error.issues[0];
  if (!issue) return { message: "Invalid request." };
  const path = issue.path.map(String);
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0] ?? "";
    const full = [...path, key].join(".");
    return { message: `Unknown option "${full}".`, param: full };
  }
  const param = path.join(".");
  return {
    message: param ? `${param}: ${issue.message}` : issue.message,
    ...(param ? { param } : {}),
  };
}

function baseApp(ctx: Ctx, opts: { bodyLimit: number }): FastifyInstance {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    bodyLimit: opts.bodyLimit, // G-13: requests here are small
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(h)
        ? h
        : newRequestId();
    },
    requestTimeout: 130_000, // a create can wait 60 s for capacity, then up to 30 s for the node
    connectionTimeout: 130_000,
    keepAliveTimeout: 65_000,
  }) as unknown as FastifyInstance;

  app.setValidatorCompiler(({ schema }) => (data: unknown) => {
    const r = (schema as z.ZodType).safeParse(data ?? {});
    return r.success
      ? { value: r.data }
      : { error: new ValidationFailure(r.error) };
  });

  // An empty body with a JSON content type is the same as no body.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (body === "") return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(
          new AppError(
            "invalid_request",
            "The request body is not valid JSON.",
          ),
          undefined,
        );
      }
    },
  );

  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    const validation = err instanceof ValidationFailure ? err.error : undefined;

    if (validation) {
      const d = describeIssue(validation);
      return send(
        reply,
        req,
        new AppError(
          "invalid_request",
          d.message,
          d.param ? { param: d.param } : {},
        ),
      );
    }
    if (err instanceof AppError) return send(reply, req, err);
    const code = (err as FastifyError).code;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return send(
        reply,
        req,
        new AppError("invalid_request", "The request body is too large."),
      );
    if (code?.startsWith("FST_ERR_CTP"))
      return send(
        reply,
        req,
        new AppError("invalid_request", "The request body could not be read."),
      );
    req.log.error(
      { err: err.message, stack: err.stack, reqId: req.id },
      "unhandled error",
    );
    return send(
      reply,
      req,
      new AppError("internal", "Something went wrong on our side."),
    );
  });

  app.setNotFoundHandler((req, reply) =>
    send(reply, req, new AppError("not_found", "No such endpoint.")),
  );
  return app;
}

function send(
  reply: FastifyReply,
  req: FastifyRequest,
  err: AppError,
): FastifyReply {
  if (err.opts.retryAfterSeconds)
    void reply.header("retry-after", String(err.opts.retryAfterSeconds));
  const body = errorResponse(err.code, err.message, req.id, err.opts.param);
  body.error.retryable = err.retryable;
  return reply.status(err.status).send(body);
}

/** The public listener (A2): what Caddy forwards. */
export function buildPublicApp(
  ctx: Ctx,
  opts: { mcp?: McpOptions } = {},
): FastifyInstance {
  const app = baseApp(ctx, { bodyLimit: 64 * 1024 });
  const authed = async (req: FastifyRequest): Promise<Auth> => {
    req.auth = await authenticate(ctx.db, ctx.clock, req.headers);
    return req.auth;
  };

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/openapi.json", async () => buildOpenApiDocument());

  app.post(
    "/v1/sessions",
    { schema: { body: CreateSessionRequest } },
    async (req, reply) => {
      const auth = await authed(req);
      const { session, created } = await createSession(
        ctx,
        auth,
        req.body as CreateSessionRequest,
      );
      return reply.status(created ? 201 : 200).send(session);
    },
  );

  app.get(
    "/v1/sessions",
    { schema: { querystring: ListSessionsQuery } },
    async (req) => {
      return listSessions(
        ctx,
        await authed(req),
        req.query as z.infer<typeof ListSessionsQuery>,
      );
    },
  );

  app.get("/v1/sessions/:id", async (req) => {
    return getSession(
      ctx,
      await authed(req),
      (req.params as { id: string }).id,
    );
  });

  app.post("/v1/sessions/:id/stop", async (req) => {
    return stopSession(
      ctx,
      await authed(req),
      (req.params as { id: string }).id,
    );
  });

  app.post(
    "/v1/sessions/:id/tokens",
    { schema: { body: MintTokenRequest } },
    async (req, reply) => {
      const token = await mintSessionToken(
        ctx,
        await authed(req),
        (req.params as { id: string }).id,
        req.body as MintTokenRequest,
      );
      return reply.status(201).header("cache-control", "no-store").send(token);
    },
  );

  app.post(
    "/v1/sessions/:id/computer",
    { schema: { body: ComputerRequest } },
    async (req) =>
      sessionComputer(
        ctx,
        await authed(req),
        (req.params as { id: string }).id,
        req.body as ComputerRequest,
      ),
  );

  app.get("/v1/sessions/:id/recording", async (req, reply) => {
    const r = await sessionRecording(
      ctx,
      await authed(req),
      (req.params as { id: string }).id,
    );
    reply
      .header("content-type", "video/mp4")
      .header("cache-control", "no-store");
    if (r.size > 0) reply.header("content-length", String(r.size));
    return reply.send(Readable.fromWeb(r.body as never));
  });

  // W2. The viewer page; it carries no secret, so it needs no key (the token is in the fragment).
  app.get("/live/:id", async (_req, reply) =>
    reply.headers(livePageHeaders(ctx.publicEndpoint.secure)).send(LIVE_PAGE),
  );

  app.get(
    "/v1/sessions/:id/events",
    { schema: { querystring: ListEventsQuery } },
    async (req) => {
      return listEvents(
        ctx,
        await authed(req),
        (req.params as { id: string }).id,
        req.query as z.infer<typeof ListEventsQuery>,
      );
    },
  );

  // P18: profiles.
  app.post(
    "/v1/profiles",
    { schema: { body: CreateProfileRequest } },
    async (req, reply) => {
      const profile = await createProfile(
        ctx,
        await authed(req),
        req.body as CreateProfileRequest,
      );
      return reply.status(201).send(profile);
    },
  );

  app.get(
    "/v1/profiles",
    { schema: { querystring: ListProfilesQuery } },
    async (req) =>
      listProfiles(
        ctx,
        await authed(req),
        req.query as z.infer<typeof ListProfilesQuery>,
      ),
  );

  app.get("/v1/profiles/:id", async (req) =>
    getProfile(ctx, await authed(req), (req.params as { id: string }).id),
  );

  app.delete("/v1/profiles/:id", async (req, reply) => {
    await deleteProfile(
      ctx,
      await authed(req),
      (req.params as { id: string }).id,
    );
    return reply.status(204).send();
  });

  // P17: the project, its keys and usage (the dashboard reads these).
  app.get("/v1/project", async (req) => getProject(ctx, await authed(req)));

  app.get("/v1/api-keys", async (req) => listApiKeys(ctx, await authed(req)));

  app.post(
    "/v1/api-keys",
    { schema: { body: CreateApiKeyRequest } },
    async (req, reply) => {
      const created = await createProjectApiKey(
        ctx,
        await authed(req),
        req.body as CreateApiKeyRequest,
      );
      return reply
        .status(201)
        .header("cache-control", "no-store")
        .send(created);
    },
  );

  app.post("/v1/api-keys/:id/revoke", async (req) =>
    revokeApiKey(ctx, await authed(req), (req.params as { id: string }).id),
  );

  app.get("/v1/usage", { schema: { querystring: UsageQuery } }, async (req) =>
    getUsage(ctx, await authed(req), req.query as z.infer<typeof UsageQuery>),
  );

  // P17: admin keys only; `not_found` to any other key (threat model T-69). The check runs
  // before body validation, so a project key cannot tell these paths exist from a 400.
  const adminOnly = {
    preValidation: async (req: FastifyRequest) => {
      requireAdmin(await authed(req));
    },
  };
  const adminAuth = (req: FastifyRequest): Auth => req.auth as Auth;

  app.get("/v1/admin/nodes", adminOnly, async () => listNodes(ctx));

  app.post(
    "/v1/admin/orgs",
    { ...adminOnly, schema: { body: AdminCreateOrgRequest } },
    async (req, reply) => {
      const org = await adminCreateOrg(
        ctx,
        adminAuth(req),
        req.body as AdminCreateOrgRequest,
      );
      return reply.status(201).send(org);
    },
  );

  app.post(
    "/v1/admin/projects",
    { ...adminOnly, schema: { body: AdminCreateProjectRequest } },
    async (req, reply) => {
      const project = await adminCreateProject(
        ctx,
        adminAuth(req),
        req.body as AdminCreateProjectRequest,
      );
      return reply.status(201).send(project);
    },
  );

  app.post(
    "/v1/admin/projects/:id/api-keys",
    { ...adminOnly, schema: { body: CreateApiKeyRequest } },
    async (req, reply) => {
      const created = await adminCreateApiKey(
        ctx,
        adminAuth(req),
        (req.params as { id: string }).id,
        req.body as CreateApiKeyRequest,
      );
      return reply
        .status(201)
        .header("cache-control", "no-store")
        .send(created);
    },
  );

  // W7: the MCP server, on the same key check as everything above.
  registerMcp(app, ctx, authed, opts.mcp);

  return app;
}

/** The internal listener (A2): localhost only. Health, metrics and the node protocol. */
export function buildInternalApp(ctx: Ctx, sweeper?: Sweeper): FastifyInstance {
  const app = baseApp(ctx, { bodyLimit: 4 * 1024 * 1024 }); // heartbeats and report batches

  app.get("/healthz", async () => ({
    status: "ok",
    // G-16: a failpoint is never invisible.
    failpoints: ctx.failpoints.describe(),
    sweeperConnectedForMs: sweeper?.connectedForMs ?? null,
  }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await ctx.db.$queryRaw`SELECT 1`;
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "database unreachable" });
    }
  });

  app.get("/metrics", async (_req, reply) => {
    const rows = await ctx.db.session.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    ctx.metrics.sessions.reset();
    for (const r of rows)
      ctx.metrics.sessions.set({ status: r.status }, r._count._all);
    return reply
      .header("content-type", ctx.metrics.registry.contentType)
      .send(await ctx.metrics.registry.metrics());
  });

  /** K6: each node has its own secret. The node id in the body must be the one the secret belongs to. */
  const nodeAuth = (req: FastifyRequest, nodeId: string): void => {
    const node = ctx.nodes.get(nodeId);
    const header = req.headers.authorization;
    const presented =
      typeof header === "string" && header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : "";
    if (!node || !presented || !safeEqual(presented, node.secret)) {
      throw new AppError("unauthorized", "Bad node credentials.");
    }
  };

  app.post(
    NODE_PATHS.register,
    { schema: { body: RegisterRequest } },
    async (req) => {
      const body = req.body as RegisterRequest;
      nodeAuth(req, body.nodeId);
      return registerNode(ctx, body);
    },
  );
  app.post(
    NODE_PATHS.heartbeat,
    { schema: { body: HeartbeatRequest } },
    async (req) => {
      const body = req.body as HeartbeatRequest;
      nodeAuth(req, body.nodeId);
      return heartbeat(ctx, body);
    },
  );
  app.post(
    NODE_PATHS.reports,
    { schema: { body: ReportsRequest } },
    async (req) => {
      const body = req.body as ReportsRequest;
      nodeAuth(req, body.nodeId);
      return ingestReports(ctx, body);
    },
  );

  return app;
}
