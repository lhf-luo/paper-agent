# Research Workspace

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

The research workspace stores reusable, source-linked organization. It is not an automatic idea generator and does not replace close reading.

## Record types

### Skim card

Use one card for one paper and one research question. The structured fields cover problem, method, datasets or experimental objects, findings, limitations, unknowns, and at least one source locator when available.

### Comparison matrix

Use a stable set of dimensions across multiple paper IDs. Each cell can carry its own page and quote locator. Do not fill missing evidence with guesses; leave it unknown or mark it for verification.

### Evidence graph

Separate the research question and human conclusion from evidence cards. Cards can support, challenge, or leave a claim unknown, and edges can express support, challenge, dependence, or contradiction.

AI suggestions are stored separately from the human conclusion.

## Authorship boundary

Each record identifies its author and whether it is human-authored or AI-assisted.

- AI-assisted content cannot overwrite a human-authored record.
- AI-assisted updates cannot change a human conclusion.
- Only a record marked as human-reviewed may be proposed to the team knowledge base.
- Saving and sharing are separate write operations with separate confirmations.

## Revisions and provenance

Persistent records use stable IDs and increasing revisions. Source locators should include paper ID, physical page, and an exact quote when possible. The workspace writes an audit trail so later users can distinguish creation, revision, and sharing.

## Recommended workflow

1. Search the personal library before creating a new record.
2. Open the primary PDF and collect exact page/quote evidence.
3. Create a skim card before attempting cross-paper synthesis.
4. Build a comparison matrix only after dimensions are defined consistently.
5. Use an evidence graph for contested or multi-source conclusions.
6. Keep unknowns and contradictory evidence visible.
7. Review every AI-assisted draft before marking it human-reviewed.
8. Propose only reusable, privacy-safe records to the team.

## Team sharing

Sharing converts the local record into team derived memory and submits it as `team-proposed`. A reviewer must approve it before it becomes reviewed team knowledge. The local source record remains separate and retains its revision history.
