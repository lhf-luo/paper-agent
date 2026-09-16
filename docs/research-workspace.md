# Research Notes Workspace

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

The research workspace is a Markdown notebook connected to the personal paper library. It provides a folder tree on the left and a multi-tab editor or preview on the right.

## Storage model

- Markdown under `.paper-agent/notes/{namespace}/` is the only source of truth for note content. Nested note folders are real directories.
- SQLite stores the folder tree plus each note ID, title, path, folder, template used at creation, revision, content hash, and paper relationships.
- A note can reference zero, one, or many papers in the same namespace.
- Deleting a paper removes only its note relationship. Deleting a note removes its Markdown file and all relationships.
- Paper Agent reconciles this directory when the workspace opens, regains focus, is refreshed manually, or an Agent queries notes. New Markdown files and folders are indexed automatically.
- Moving or renaming an indexed file preserves its stable note ID and paper relationships when its `--{short-note-id}` filename suffix remains intact. An unchanged file can also be recognized by its unique content hash.
- External body edits update the stored hash and revision. External file deletion removes only the SQLite index and paper relationships because the file is already gone.
- Empty folders can be deleted; non-empty folders must be cleared or moved first.

## Templates

Templates live in `.paper-agent/templates/research-notes/`. The built-in `skim.md`, `deep-reading.md`, and `comparison-matrix.md` templates contain an evidence-traceable skim card, a 12-section close-reading report, and a cross-paper comparison matrix. Their defaults ship under `.agents/skills/paper-research/assets/research-notes/` and are copied into the local template directory on initialization. Original zero-byte built-in templates are filled on refresh; nonempty user-edited templates are preserved. Any top-level Markdown file added to this directory becomes available after the template list is refreshed.

A template is copied only when the note is created. Later template edits do not change existing notes. The Blank option creates an empty note without a template file.

## Editing and conflicts

The editor saves after input pauses. Open tabs and expanded folders are remembered per namespace in the current browser. Switching or closing the active tab first saves its draft. Each save sends the expected revision and content hash. If the Markdown file was changed outside Paper Agent while an older draft remains open, the server returns a conflict instead of overwriting either version.

The refresh button in the note sidebar performs the same reconciliation on demand. Symlinks are ignored, and Markdown files larger than 2 MB stop that reconciliation with an error instead of causing partial index deletion.

Creating and deleting notes or folders follows the research confirmation setting. Editing the body is direct. The note menu's edit card updates title, folder and paper relationships together so it cannot leave a half-updated note.

## Agent tools

- `search_research_notes` searches by title, note ID, or linked paper ID and can return the Markdown body. Pass `template_id` to read the current local template before filling a note.
- `manage_research_note` creates, updates, deletes, links, or unlinks notes. Agent mutations continue to use the configured confirmation policy.

Agent-written skim cards and close-reading notes should be saved as Markdown. Evidence locators such as paper ID, PDF version, page, section, figure, table, and quotation belong in the Markdown body rather than in separate structured research tables.

The `paper-research` Skill creates notes when explicitly requested, including a combined request such as “精读这篇论文并保存笔记”. It reads the chosen template and passes the completed analysis as `markdown` to `manage_research_note`; passing only `template_id` creates a skeleton. Ordinary reading requests stay in the conversation. Existing human notes are updated only when requested, and note writes retain the configured confirmation policy.
