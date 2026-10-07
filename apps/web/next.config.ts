import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

/**
 * Threat model T-68: session data is attacker-controlled, so the dashboard allows no script
 * but its own and no framing. Next.js needs inline scripts for hydration ('unsafe-inline'
 * without a nonce) and, in development only, eval.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${dev ? " ws:" : ""}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const config: NextConfig = {
  transpilePackages: ["@kestrel/dashboard"],
  poweredByHeader: false,
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into this folder.
  agentRules: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "content-security-policy", value: csp },
          { key: "x-frame-options", value: "DENY" },
          { key: "x-content-type-options", value: "nosniff" },
          { key: "referrer-policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;
