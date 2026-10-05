import { spawn } from "node:child_process";
import { LIMITS } from "@kestrel/contracts";
import { CaptchaWatcher } from "./captcha.js";
import { ViewportSizer } from "./cdp.js";
import { ControlServer } from "./control.js";
import { Env } from "./config.js";
import { CdpForward } from "./forward.js";
import { LiveServer } from "./live.js";
import { Recorder } from "./recorder.js";
import { Tabs } from "./page.js";
import { Supervisor, type Proc } from "./supervisor.js";

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error(
    `invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
  );
  process.exit(2);
}
const cfg = parsed.data;
const log = (msg: string, extra: object = {}): void =>
  console.log(JSON.stringify({ t: Date.now(), msg, ...extra }));

// Docker's init is PID 1; this is its only real child. If anything essential dies, the container stops (R6).
const supervisor = new Supervisor(
  cfg,
  (cmd, args, env) =>
    spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    }) as unknown as Proc,
  (why) => {
    log("fatal: stopping the container", { why });
    process.exit(1);
  },
);

// Size the window to the default viewport while the browser warms (A6), on the connection
// configure will use: a session asking for that viewport then only has it measured.
const sizer = new ViewportSizer(cfg.CHROME_PORT);
supervisor.prepare = () => sizer.apply(LIMITS.defaultViewport);

const tabs = new Tabs();
const recorder = new Recorder(
  cfg.RECORDING_DIR,
  cfg.DISPLAY_NUM,
  undefined,
  log,
);
const captcha = new CaptchaWatcher(cfg.CHROME_PORT, log);
const live = new LiveServer(cfg.CHROME_PORT, tabs, log);
const forward = new CdpForward(cfg.CHROME_PORT, live);
const control = new ControlServer(
  cfg.KESTREL_CONTROL_TOKEN,
  supervisor,
  forward,
  cfg.CHROME_PORT,
  tabs,
  recorder,
  sizer,
  cfg.SNAPSHOT === "on",
  captcha,
);

await forward.listen(cfg.FORWARD_PORT);
await control.listen(cfg.CONTROL_PORT);
log("runtimed listening", {
  control: cfg.CONTROL_PORT,
  forward: cfg.FORWARD_PORT,
  sandbox: cfg.CHROME_SANDBOX,
});
await supervisor.start();
log("browser ready", { version: supervisor.chromeVersion });

// Docker stops a container with SIGTERM: finish the recording's last fragment first (StopTimeout is short).
process.on("SIGTERM", () => {
  void recorder.stop(1500).finally(() => process.exit(0));
});
