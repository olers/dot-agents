# dot-agents

[![npm version](https://img.shields.io/npm/v/@linemagic/dot-agents.svg)](https://www.npmjs.com/package/@linemagic/dot-agents)
[![license](https://img.shields.io/npm/l/@linemagic/dot-agents.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@linemagic/dot-agents.svg)](https://nodejs.org)

**English** | [简体中文](./README.zh-CN.md)

Consolidate the skills / commands / agents / hooks scattered across `.claude/`, `.codebuddy/`, `.cursor/`, and other tool directories into a single source of truth — `.agents/` — and replace the rest with symlinks pointing back to it.

Edit once; every AI tool sees the change.

## Features

- **Single source of truth.** `.agents/` is the only tracked copy; everything else is a symlink.
- **Plan before apply.** The default command never writes to disk directly — it scans, computes a change plan, and shows it in the browser for your confirmation.
- **Conflict-safe.** Same name but different content? It stops and asks. It never picks for you and never auto-merges.
- **Relative symlinks.** Links survive being moved to another machine.
- **Full backups.** Everything moved or deleted is backed up with a generated `undo.sh`. Failures roll back atomically.
- **No daemon by default.** The default mode runs once and exits — no daemon, no fixed port; use the explicit `serve` host mode when you need it resident.

## Requirements

- Node.js >= 18

## Usage

```bash
npx @linemagic/dot-agents           # Launch browser: review status, inspect the plan, resolve conflicts, apply on confirm
npx @linemagic/dot-agents status    # Terminal only, read-only
npx @linemagic/dot-agents apply -y  # Headless (entries with unresolved conflicts are skipped)
npx @linemagic/dot-agents link      # Idempotent "install": add missing symlinks only — never moves or deletes anything
```

The default command **does not modify files directly.** It scans the repo, computes a change plan, and lays out in the browser what will change, the risks, and the benefits. The backend acts only after you confirm.

Hover any entry in the graph to read its frontmatter description; open it to see the file list and the content of each file — so before resolving a conflict, you can see exactly how the two copies of `foo` differ.

### Host mode (serve)

The default command is "run once, use once": random port, auto-opens the browser, exits on Ctrl-C — still the only interactive usage.
`serve` is an explicit opt-in mode for an **external host** (such as a portal-style tool) to manage:

    dot-agents serve --port 18852 --repo /path/to/repo --allow-embed "http://localhost:5273"

- Stays resident in the foreground, never opens a browser; its lifecycle belongs to the host (graceful exit on SIGINT/SIGTERM).
- The first stdout line is a single JSON line `{"app":"dot-agents","url":"...","port":...}`; nothing else is written to stdout afterward.
- `--port` exits 1 if the port is taken — it never switches ports; `--repo` defaults to the git root of the current directory.
- `--allow-embed` is written verbatim into the CSP `frame-ancestors` (space-separate multiple origins); no CSP header when omitted.
- Security: binds 127.0.0.1 only; Host-header allowlist (blocks DNS rebinding); `/api/*` still requires the page-injected token; the only token-free endpoint is `GET /healthz` (returns app/version/repoRoot, for the host to identify it).

## Result layout

```
.agents/
  skills/       ← single source, tracked in git
  commands/
.claude/
  skills   -> ../.agents/skills      ← symlink, not tracked
  settings.json                      ← tool-specific, left untouched
.codebuddy/
  skills   -> ../.agents/skills
```

Symlinks stay out of git; `.agents/` goes in. After cloning, run `npx @linemagic/dot-agents link` once to restore the symlinks. Links are always **relative**, so they keep working on another machine.

## Conflicts

When two entries share a name but differ in content (e.g. `.claude/skills/foo` and `.codebuddy/skills/foo`), the tool **stops and asks you**. It never chooses on your behalf and never auto-merges.

An unresolved conflict keeps the **entire dimension unlinked** — because symlinks are directory-level, one entry left in `.claude/skills/` is enough to prevent that directory from becoming a symlink. The UI tells you exactly which directories were skipped for this reason.

Duplicate copies with **identical content** are not conflicts — they're deduplicated silently.

## What it does not do

- **No format conversion.** It only handles same-name directories with matching formats. `rules/` formats are mutually incompatible (`.cursor` uses `.mdc` with frontmatter globs; `.claude` has no `rules/` concept at all), so they're listed under "tool-specific" — visible but untouched.
- **No changes to global directories.** `~/.claude` and the like are shown read-only.
- **Not resident by default.** The default mode has no daemon and no fixed port and exits when done; residency happens only in the explicit `serve` host mode.

## Safety net

Before any change, everything that will be moved or deleted is backed up to `.agents/.attic/<timestamp>/backup/`, along with an executable `undo.sh`. A mid-run failure rolls back **as a whole**, leaving no half-applied state.

**Backups are not optional.** In most repos `.claude/` is gitignored — git never tracked it, so `git checkout` can't bring it back. `.attic/` is the only way to undo, so it cannot be disabled and `--force` cannot skip it.

(`--force` only skips the "git working tree must be clean" gate; it never skips the backup.)

## Development

```bash
npm install
npm test        # vitest. Core tests run against real temp directories, no fs mocking —
                # symlink behavior IS the whole point of this tool, so mocking it would test nothing.
npm run build
```

Design doc: `docs/superpowers/specs/2026-07-11-dot-agents-design.md`

## License

MIT © LineMagic
