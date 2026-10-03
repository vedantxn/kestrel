import { finish } from "./report.js";
import { m1ConfigFromEnv, runM1 } from "./m1.js";
import { m2ConfigFromEnv, runM2 } from "./m2.js";

const [command] = process.argv.slice(2);
const log = (m: string): void =>
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

if (command === "m1") {
  const report = await runM1(m1ConfigFromEnv(process.env, log));
  process.exit(finish(report, process.env.REPORT_DIR ?? "/reports"));
} else if (command === "m2") {
  const report = await runM2(m2ConfigFromEnv(process.env, log));
  process.exit(finish(report, process.env.REPORT_DIR ?? "/reports"));
} else {
  console.error(
    "usage: cli m1|m2   (configuration from the environment; see bench/framework/src/m1.ts)",
  );
  process.exit(2);
}
