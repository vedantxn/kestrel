import { z } from "zod";

/**
 * W4. `POST /v1/sessions/{id}/computer`: drive the browser with screenshots and mouse and
 * keyboard over plain HTTP, no CDP client needed. One action per call. The same body travels
 * API -> node agent -> runtimed unchanged, and each hop validates it again.
 */
const Coord = z.number().int().min(0).max(10_000);
const Button = z.enum(["left", "middle", "right"]);

export const COMPUTER_LIMITS = {
  maxTextChars: 10_000,
  actionTimeoutMs: 10_000,
} as const;

export const ComputerAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot") }).strict(),
  z
    .object({
      action: z.literal("click"),
      x: Coord,
      y: Coord,
      button: Button.default("left"),
      clicks: z.number().int().min(1).max(3).default(1),
      screenshot: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("move"),
      x: Coord,
      y: Coord,
      screenshot: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      x: Coord,
      y: Coord,
      dx: z.number().int().min(-10_000).max(10_000).default(0),
      dy: z.number().int().min(-10_000).max(10_000),
      screenshot: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("type"),
      text: z.string().min(1).max(COMPUTER_LIMITS.maxTextChars),
      screenshot: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("key"),
      /** A DOM key name such as `Enter`, `Tab`, `ArrowDown`, `Backspace`, or one character. */
      key: z.string().min(1).max(32),
      screenshot: z.boolean().default(false),
    })
    .strict(),
]);
export const ComputerRequest = ComputerAction.meta({ id: "ComputerRequest" });
export type ComputerRequest = z.infer<typeof ComputerAction>;

export const ComputerResponse = z
  .object({
    ok: z.literal(true),
    /** PNG, base64; present for `screenshot` and when an action asked for one. */
    screenshot: z.string().optional(),
    /** The page's size in CSS pixels; coordinates are in the same space. */
    width: z.number().int(),
    height: z.number().int(),
    url: z.string(),
  })
  .meta({ id: "ComputerResponse" });
export type ComputerResponse = z.infer<typeof ComputerResponse>;
