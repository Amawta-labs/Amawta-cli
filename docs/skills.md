# Skills & Plugins

Amawta supports the [Agent Skills](https://agentskills.io) open format for extending agent capabilities with reusable instruction sets.

- **Agent Skills** (directories containing `SKILL.md` - see [specification](https://agentskills.io/specification))
- **Marketplace compatibility** (`.amawta-plugin/marketplace.json`, legacy `.claude-plugin/marketplace.json`)
- **Plugin packs** installed via `amawta plugin install ...`
- **Install from any repository** using [`add-skill` CLI](https://github.com/vercel-labs/add-skill)

This doc is a compact reference for installing/using/creating/distributing skills.

## Quick Install with add-skill

Install skills from any git repository:

```bash
# Install from GitHub
npx add-skill vercel-labs/agent-skills -a amawta

# Install to global directory
npx add-skill vercel-labs/agent-skills -a amawta -g

# Install specific skills
npx add-skill vercel-labs/agent-skills -a amawta -s pdf -s xlsx
```

## Install skills (marketplace → plugin pack)

Add a marketplace:

```bash
# Local marketplace repo/directory
amawta plugin marketplace add ./path/to/marketplace-repo

# GitHub shorthand (downloads a zip)
amawta plugin marketplace add owner/repo

# List configured marketplaces
amawta plugin marketplace list
```

Install a plugin pack from a marketplace:

```bash
# User scope: writes to ~/.amawta/...
amawta plugin install <plugin>@<marketplace> --scope user

# Project scope: writes to ./.amawta/...
amawta plugin install <plugin>@<marketplace> --scope project

# Disable/enable installed plugin
amawta plugin disable <plugin>@<marketplace> --scope user
amawta plugin enable <plugin>@<marketplace> --scope user
```

Interactive equivalents:

```text
/plugin marketplace add owner/repo
/plugin install <plugin>@<marketplace> --scope user
```

## Use skills

In interactive mode, run a skill as a slash command:

```text
/pdf
/xlsx
```

Amawta can also invoke skills automatically via the `Skill` tool when relevant.

## Create a skill (Agent Skills format)

Directory layout:

```text
./.amawta/skills/<skill-name>/SKILL.md
```

Minimal `SKILL.md`:

```md
---
name: my-skill
description: What this skill does and when to use it.
allowed-tools: Read Bash(git:*) Bash(jq:*)
---

Step-by-step instructions here…
```

Rules:

- `name` must match the parent directory name
- Lowercase letters, numbers, and hyphens only (`a-z0-9-`), 1–64 chars

Compatibility:

- Amawta also discovers `.claude/skills` and `.claude/commands` for legacy compatibility.

## Distribute skills

### Marketplace (`.amawta-plugin/marketplace.json`)

A marketplace is a repo/directory that contains:

```text
.amawta-plugin/marketplace.json
```

Example (skill pack plugins):

```json
{
  "name": "my-marketplace",
  "metadata": { "description": "Example skills", "version": "1.0.0" },
  "plugins": [
    {
      "name": "document-skills",
      "source": "./",
      "skills": ["./skills/pdf", "./skills/xlsx"]
    }
  ]
}
```

### Plugin (`.amawta-plugin/plugin.json`)

For full plugins (beyond simple skill packs), place:

```text
.amawta-plugin/plugin.json
```

Key rules (per upstream spec):

- `name` must be kebab-case and unique
- All component paths must be relative and start with `./`
- No `../` segments; forward slashes only

## Recommended publishing workflow

- Put skill packs in a GitHub repo with `.amawta-plugin/marketplace.json` (legacy `.claude-plugin/marketplace.json` is also supported).
- Users add it via `amawta plugin marketplace add owner/repo`.
- Keep skill/plugin versions semver in your manifests (and tags/releases in GitHub).
