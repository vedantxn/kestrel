import { settledInvariants } from "./collect.js";
import { checkInvariants } from "./invariants.js";
import { finish, makeReport } from "./report.js";
import { m1ConfigFromEnv, runM1 } from "./m1.js";
import { m2ConfigFromEnv, runM2 } from "./m2.js";
import { captchaCheckConfigFromEnv, runCaptchaCheck } from "./captcha-check.js";
import { churnConfigFromEnv, runChurn } from "./churn.js";
import { proxyCheckConfigFromEnv, runProxyCheck } from "./proxy-check.js";

const [command] = process.argv.slice(2);
const log = (m: string): void =>
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

if (command === "m1") {
  const report = await runM1(m1ConfigFromEnv(process.env, log));
  process.exit(finish(report, process.env.REPORT_DIR ?? "/reports"));
} else if (command === "m2") {
  const report = await runM2(m2ConfigFromEnv(process.env, log));
  process.exit(finish(report, process.env.REPORT_DIR ?? "/reports"));
} else if (command === "invariants") {
  // One check with nothing expected on: no failpoints, the agents' probe controls off, nothing leaked.
  const cfg = m1ConfigFromEnv(process.env, log);
  const r = await settledInvariants(checkInvariants, cfg.host, {
    timeoutMs: Number(process.env.SETTLE_MS ?? 30_000),
  });
  const report = makeReport("invariants", cfg.environment);
  report.add({
    id: "1",
    name: "nothing leaked or inconsistent, and nothing left on",
    pass: r.ok,
    detail: r.ok
      ? "clean"
      : r.violations.map((v) => `${v.rule}: ${v.detail}`).join("; "),
  });
  process.exit(finish(report.build(), process.env.REPORT_DIR ?? "/reports"));
} else if (command === "proxy") {
  const report = await runProxyCheck(proxyCheckConfigFromEnv(process.env, log));
  process.exit(finish(report, process.env.REPORT_DIR ?? "/reports"));
} else if (command === "captcha") {
  const report = await runCaptchaCheck(
    captchaCheckConfigFromEnv(process.env, log),
  );
  process.exit(finish(report, process.env.REPORT_DIR ?? "/reports"));
} else if (command === "churn") {
  const report = await runChurn(churnConfigFromEnv(process.env, log));
  process.exit(finish(report, process.env.REPORT_DIR ?? "/reports"));
} else {
  console.error(
    "usage: cli m1|m2|invariants|churn|proxy|captcha   (configuration from the environment; see bench/framework/src/m1.ts)",
  );
  process.exit(2);
}
