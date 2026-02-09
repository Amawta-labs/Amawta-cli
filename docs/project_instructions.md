# Project Instructions (AGENTS.md / CLAUDE.md)

Amawta supports **project-scoped instruction files** that are automatically loaded and provided as additional context during runs.

## Files

- `AGENTS.md`: primary project instruction file.
- `AGENTS.override.md`: optional override that *replaces* `AGENTS.md` in the same directory.
- `CLAUDE.md`: legacy compatibility file; read and included as a separate “legacy” section when present.

## Discovery Order (Deterministic)

When Amawta needs project instructions, it discovers instruction files from:

1. **Git root → current working directory**, walking one directory at a time.
2. In each directory:
   - If `AGENTS.override.md` exists, it is used (and `AGENTS.md` in the same directory is ignored).
   - Otherwise, if `AGENTS.md` exists, it is used.

This produces a deterministic, ordered stack like:

- `AGENTS.md`
- `subdir/AGENTS.md`
- `subdir/nested/AGENTS.override.md`

## Merge Format

Discovered instruction files are concatenated in order. By default, Amawta includes a heading per file:

- `# AGENTS.md` / `# AGENTS.override.md`
- `_Path: <relative path from git root>_`

## Size Limit

To keep prompts bounded, Amawta enforces a total byte budget while concatenating instruction files.

- Default: **32 KiB**
- Override via env var: `AMAWTA_PROJECT_DOC_MAX_BYTES=<number>`

If the budget is exceeded, the final content is truncated with a suffix indicating truncation.

## Legacy CLAUDE.md

If a `CLAUDE.md` exists in the **current working directory**, Amawta appends it after AGENTS content under:

`# Legacy instructions (CLAUDE.md)`

`CLAUDE.md` is supported for compatibility; prefer using `AGENTS.md` for new projects.

