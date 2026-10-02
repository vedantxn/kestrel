import { redactToken } from "@kestrel/contracts";
import { pino, type DestinationStream, type Logger } from "pino";

/**
 * G-01. Secrets never reach a log: the `token` query parameter is stripped from any URL,
 * and the headers that carry credentials are redacted wherever they appear. Request bodies
 * are never logged.
 */
export function createLogger(
  name: string,
  level = "info",
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      name,
      level,
      redact: {
        paths: [
          "req.headers.authorization",
          'req.headers["x-api-key"]',
          "req.headers.cookie",
          "headers.authorization",
          'headers["x-api-key"]',
          "*.token",
          "*.apiKey",
          "*.proof",
          "*.secret",
        ],
        censor: "[redacted]",
      },
      serializers: {
        req: (req: { method?: string; url?: string; id?: string }) => ({
          method: req.method,
          url: req.url ? redactToken(req.url).split("?")[0] : undefined,
          id: req.id,
        }),
      },
    },
    destination,
  );
}

export type { Logger };
