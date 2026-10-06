import { redactToken } from "@kestrel/contracts";
import { pino, type DestinationStream, type Logger } from "pino";

/**
 * G-01. Secrets never reach a log: the `token` query parameter is stripped from any URL,
 * and the headers that carry credentials are redacted wherever they appear. Request bodies
 * are never logged. An upstream proxy's password, and the `Proxy-Authorization` value made from
 * it, are redacted at any depth a log call is likely to nest them.
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
          // A CAPTCHA solver service's key (T-61), wherever a start request might nest it.
          "apiKey",
          "*.apiKey",
          "*.*.apiKey",
          "*.*.*.apiKey",
          "clientKey",
          "*.clientKey",
          "*.*.clientKey",
          "*.proof",
          "*.secret",
          'req.headers["proxy-authorization"]',
          'headers["proxy-authorization"]',
          "password",
          "*.password",
          "*.*.password",
          "*.*.*.password",
          "authorization",
          "*.authorization",
          "*.*.authorization",
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
