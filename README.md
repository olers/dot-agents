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
- **No daemon.** No resident process, no fixed port. The server exits when it's done.

## Requirements

- Node.js >= 20

## Usage

```bash
npx @linemagic/dot-agents           # Launch browser: review status, inspect the plan, resolve conflicts, apply on confirm
npx @linemagic/dot-agents status    # Terminal only, read-only
npx @linemagic/dot-agents apply -y  # Headless (entries with unresolved conflicts are skipped)
npx @linemagic/dot-agents link      # Idempotent "install": add missing symlinks only — never moves or deletes anything
```

The default command **does not modify files directly.** It scans the repo, computes a change plan, and lays out in the browser what will change, the risks, and the benefits. The backend acts only after you confirm.

Hover any entry in the graph to read its frontmatter description; open it to see the file list and the content of each file — so before resolving a conflict, you can see exactly how the two copies of `foo` differ.

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
- **No daemon.** No resident process, no fixed port. The server exits when it's done.

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
