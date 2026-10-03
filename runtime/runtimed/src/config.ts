import { z } from "zod";

export const Env = z.object({
  /** The bearer token the node agent chose for this container's control API. */
  KESTREL_CONTROL_TOKEN: z.string().min(16),
  /** The egress gateway: Chrome's only way out (R8). */
  KESTREL_PROXY: z.string().regex(/^http:\/\/[0-9.]+:\d+$/),
  KESTREL_NODE: z.string().default("a"),
  CHROME_PATH: z.string().default("/opt/chrome/chrome"),
  XVFB_PATH: z.string().default("Xvfb"),
  DISPLAY_NUM: z.string().default(":99"),
  /** The virtual screen. Chrome's window sits at the top-left (R3). */
  SCREEN: z.string().default("1920x1080x24"),
  PROFILE_DIR: z.string().default("/profile"),
  /** W3. The recording volume, mounted by the agent when it can give the container one. */
  RECORDING_DIR: z.string().default("/artifacts"),
  /** Chrome's own sandbox: on unless experiment V1 says it cannot work here (R12). */
  CHROME_SANDBOX: z.enum(["on", "off"]).default("on"),
  CONTROL_PORT: z.coerce.number().int().default(9000),
  FORWARD_PORT: z.coerce.number().int().default(9223),
  CHROME_PORT: z.coerce.number().int().default(9222),
  LOG_LEVEL: z.string().default("info"),
});
export type Env = z.infer<typeof Env>;
