# Paper Agent Documentation

[English README](../README.md) | [中文 README](../README.zh-CN.md)

The main README is the quick entry point. These guides explain individual workflows, boundaries, and operational details.

## Start here

- [Web Agent user guide](web-agent-guide.md) ([简体中文](web-agent-guide.zh-CN.md)) — start, configure a model, use the literature-research Skill, choose session modes, handle confirmations, and follow common workflows.
- [Web interface](web-interface.md) — pages, built-in Agent chat, local session security, confirmations, and common UI workflows.
- [CLI installation and commands](cli.md) — install, initialize, diagnose, start Web/Pi modes, and uninstall.
- [Model and relay configuration](model-configuration.md) — ephemeral Web Agent credentials, project environment variables, advanced Pi login, custom relays, and tool-calling checks.

## Research workflows

- [Literature providers and recovery](literature-providers.md) — provider coverage, query modes, rate limits, checkpoints, and resumable failures.
- [PDF and artifact workspace](pdf-artifact-workspace.md) — layout analysis, crop correction, link discovery, safe acquisition, and provenance.
- [Personal libraries](libraries.md) — personal versus team scope, once versus persistent lifetime, versions, and reuse.
- [Personal SQLite schema](personal-sqlite-schema.md) — every personal-library table, field, constraint, and purpose.
- [Research notes workspace](research-workspace.md) — Markdown notes, templates, paper relationships, and conflict-safe editing.
- [Research Wiki](research-wiki.md) — declaration-level evidence, batch ingest, chunk search, and deterministic lint.
- [Agent tool catalog](agent-tools.md) — generated list of registered extension tools and Agent operating requirements.
- [Team knowledge base](team-knowledge-base.md) — roles, proposals, review, audit, tokens, blobs, and backups.
- [End-to-end research workflow](research-workflow.md) — how the pieces form a human-led paper-research process.

## Deployment and implementation contracts

- [Team library developer handoff](team-handoff.md)
- [Team library improvement plan](team-improvement-plan.md) — phased work plan for the team library and team server, with review checklist.
- [Standalone team-service deployment](../team-server/README.md)
- [Literature Corpus Manager Skill](../.agents/skills/literature-corpus-manager/SKILL.md)
- [Workflow contract](../.agents/skills/literature-corpus-manager/references/workflow-contract.md)
- [Corpus policy](../.agents/skills/literature-corpus-manager/references/corpus-policy.md)
