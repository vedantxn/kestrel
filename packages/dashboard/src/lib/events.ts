import type { CaptchaProvider, SessionEvent } from "@kestrel/contracts";
import { humanize } from "@kestrel/dashboard/lib/format";

/**
 * One line of plain text per event. Event data comes from inside a session and is hostile
 * (threat model T-68): it is only ever interpolated into strings React renders as text.
 */
export const CAPTCHA_LABEL: Record<CaptchaProvider, string> = {
  recaptcha: "reCAPTCHA",
  hcaptcha: "hCaptcha",
  turnstile: "Cloudflare Turnstile",
  cloudflare_challenge: "Cloudflare challenge",
  arkose: "Arkose",
  datadome: "DataDome",
  perimeterx: "HUMAN (PerimeterX)",
  geetest: "GeeTest",
  aws_waf: "AWS WAF",
};

export type EventTone = "default" | "good" | "warn" | "bad";

export function describeEvent(e: SessionEvent): {
  title: string;
  detail: string;
  tone: EventTone;
} {
  switch (e.type) {
    case "session.requested":
      return { title: "Requested", detail: "", tone: "default" };
    case "session.scheduled":
      return {
        title: "Scheduled",
        detail: `on node ${e.data.nodeId}`,
        tone: "default",
      };
    case "session.starting":
      return { title: "Starting", detail: "", tone: "default" };
    case "session.ready":
      return {
        title: "Ready",
        detail: `${e.data.startPath} start in ${Math.round(e.data.readyMs)} ms`,
        tone: "good",
      };
    case "session.attached":
      return {
        title: "Client connected",
        detail: `${e.data.connections} connection${e.data.connections === 1 ? "" : "s"}`,
        tone: "default",
      };
    case "session.detached":
      return {
        title: "Client disconnected",
        detail: `${e.data.connections} left`,
        tone: "default",
      };
    case "session.stopping":
      return {
        title: "Stopping",
        detail: humanize(e.data.endReason),
        tone: "default",
      };
    case "session.ended":
      return {
        title: `Ended (${humanize(e.data.status).toLowerCase()})`,
        detail: humanize(e.data.endReason),
        tone: e.data.status === "failed" ? "bad" : "default",
      };
    case "egress.denied":
      return {
        title: "Connection refused",
        detail: `${e.data.host}:${e.data.port} · ${humanize(e.data.reason)}${e.data.count > 1 ? ` · ×${e.data.count}` : ""}`,
        tone: "warn",
      };
    case "runtime.crashed":
      return {
        title: `${humanize(e.data.process)} crashed`,
        detail: [
          e.data.exitCode !== null ? `exit ${e.data.exitCode}` : "",
          e.data.signal ?? "",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: "bad",
      };
    case "node.lost":
      return {
        title: "Node lost",
        detail: `node ${e.data.nodeId}`,
        tone: "bad",
      };
    case "captcha.detected":
      return {
        title: `CAPTCHA: ${CAPTCHA_LABEL[e.data.provider]}`,
        detail: e.data.host ?? "",
        tone: "warn",
      };
    case "captcha.cleared":
      return {
        title: `CAPTCHA gone: ${CAPTCHA_LABEL[e.data.provider]}`,
        detail: "",
        tone: "good",
      };
    case "captcha.solving":
      return {
        title: `Solving CAPTCHA: ${CAPTCHA_LABEL[e.data.provider]}`,
        detail: e.data.host ?? "",
        tone: "default",
      };
    case "captcha.solved":
      return {
        title: `CAPTCHA solved: ${CAPTCHA_LABEL[e.data.provider]}`,
        detail: `in ${Math.round(e.data.durationMs)} ms${e.data.callback ? "" : " · token set, no callback"}`,
        tone: "good",
      };
    case "captcha.failed":
      return {
        title: `CAPTCHA not solved: ${CAPTCHA_LABEL[e.data.provider]}`,
        detail: humanize(e.data.reason),
        tone: "warn",
      };
  }
}
