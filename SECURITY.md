# Security

Kestrel runs untrusted web pages for untrusted callers, so isolation bugs matter more than most.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on this repository. Please do not open a public issue.

Include what you did, what you expected, and what happened, with the version (`git describe`) and the runtime (Docker or microVM). You will get an answer within a week.

## What counts

Anything that breaks a boundary in [`docs/threat-model.md`](docs/threat-model.md), for example:

- a session reaching another session, the host, the control plane, cloud metadata or a private address;
- a token or key that grants more than it should, or outlives its session;
- state from one session showing up in another (including through microVM snapshot clones);
- input read back from a browser that the platform trusts without checking.

The threat model lists the gaps that are known and accepted. A report that one of them is exploitable in a way the model does not describe is still welcome.

## Supported versions

Only the latest release gets fixes.
