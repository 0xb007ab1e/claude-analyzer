# Security Policy

Claude Analyzer is a **local developer tool** that browses and edits the files
Claude Code keeps in a `.claude` directory — data that often contains real
secrets (OAuth tokens, API keys) and personal context. Security is therefore a
first-class concern. Thank you for helping keep it safe.

## Supported versions

This project is pre-1.0 and ships from `main`; there are no tagged releases yet.
Security fixes land on `main` and are the only supported version. Pull the
latest before reporting.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| anything older  | ❌ — update first |

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately via GitHub:

1. Go to the repository's **Security** tab →
   [**Report a vulnerability**](https://github.com/0xb007ab1e/claude-analyzer/security/advisories/new).
2. Describe the issue, affected version/commit, impact, and clear reproduction
   steps (a minimal PoC helps). **Do not include real secrets** — redact tokens
   and paths.

This opens a private advisory visible only to you and the maintainer.

### What to expect

This is a small, single-maintainer project, so timelines are best-effort:

- **Acknowledgement** within ~3 business days.
- **Triage & severity** assessment (CVSS-based) shortly after; higher severity
  is prioritized.
- A fix on `main` and a published [GitHub Security Advisory](https://github.com/0xb007ab1e/claude-analyzer/security/advisories)
  (with credit, if you'd like) once resolved.

Coordinated disclosure is appreciated — please give a reasonable window to fix
before any public write-up.

## Security model (what the tool already does)

- **Loopback by default** with a Host-header **allowlist** (anti-DNS-rebinding);
  binding a non-loopback interface is opt-in (`--host`).
- **Path confinement** — all file access is resolved and confined to the
  configured root, including symlink checks (no traversal).
- **Secrets redacted by default**; revealing raw contents is an explicit,
  audit-logged action.
- **Guarded writes** — JSON/JSONL validation, a timestamped backup before
  overwrite, and a confirm step; an optional `--read-only` mode disables writes.
- **Zero runtime dependencies** — no third-party packages in the runtime path.

## Operator responsibilities (out of scope)

The following are the operator's responsibility, not tool vulnerabilities:

- Exposing the server on a public/untrusted network (it is meant for loopback /
  a trusted LAN or Tailscale). Treat anyone who can reach the port as able to
  read/write the `.claude` tree.
- Using **Reveal** to display real secrets on screen, or sharing screenshots /
  the served data.
- Pointing `--root` at a directory whose contents you don't intend to expose.

Reports requiring the attacker to already control the host, the filesystem, or
the loopback interface are generally out of scope.
