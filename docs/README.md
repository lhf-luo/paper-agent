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
- [Artifact discovery human evaluation](artifact-evaluation.md) — pinned-PDF review queue, page checklist, candidate decisions, exact confirmation, and the strict gold gate.
- [Personal libraries](libraries.md) — personal versus team scope, once versus persistent lifetime, versions, and reuse.
- [Research workspace](research-workspace.md) — skim cards, comparison matrices, evidence graphs, and human/AI boundaries.
- [Team knowledge base](team-knowledge-base.md) — roles, proposals, review, audit, tokens, blobs, and backups.
- [End-to-end research workflow](research-workflow.md) — how the pieces form a human-led paper-research process.

## Deployment and implementation contracts

- [Production team-service deployment](../deployment/team-corpus/README.md)
- [Literature Corpus Manager Skill](../skills/literature-corpus-manager/SKILL.md)
- [Workflow contract](../skills/literature-corpus-manager/references/workflow-contract.md)
- [Corpus policy](../skills/literature-corpus-manager/references/corpus-policy.md)
