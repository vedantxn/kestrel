import { z } from "zod";

/** Postgres cannot store NUL in text or jsonb, and no caller string needs control characters. */
export const PlainText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      (v) => !/[\u0000-\u001f\u007f]/.test(v),
      "must not contain control characters",
    );
