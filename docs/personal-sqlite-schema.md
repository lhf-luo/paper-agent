# 个人工作区 SQLite 结构

个人数据使用唯一的 `.paper-agent/corpus/personal.sqlite`，按业务 ID 读写。API 和 Agent 工具是读写入口；不要直接修改数据库。

Search Run 完整保留，不设数量上限，也不会因为新搜索而自动删除旧记录；同一 Run ID 的更新仍写回原记录。

论文 PDF 位于 `.paper-agent/files/personal/<paperId>/`，笔记正文位于 `.paper-agent/notes/`，Wiki 正文位于 `.paper-agent/wiki/`。SQLite 保存元数据、关系、修订、文件校验值与会话投影；Pi JSONL 仍保存模型原生上下文。资讯与后台任务分别保存在 `runtime/arxiv-news.sqlite`、`runtime/jobs.sqlite`；可重建的 Wiki 索引位于 `wiki/wiki.sqlite`。

数据库直接初始化当前结构，不自动迁移或导入旧格式。团队服务使用独立协议和权限，远端空间标识仅用于团队连接及来源记录。

以下建表语句来自当前代码初始化的数据库（不含 FTS 内部影子表）。时间采用 ISO 8601，布尔值采用整数，JSON 列保存合法 JSON。论文关联使用内部 `papers.row_id`，外部使用 `paper_id`；删除论文级联清理关系和论文会话，并通过清理队列删除运行时文件。

## artifact_manifests

```sql
CREATE TABLE artifact_manifests (
  id TEXT NOT NULL,
  paper_id TEXT,
  pdf_sha256 TEXT,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id)
  );
```

## canvas_research_records

```sql
CREATE TABLE canvas_research_records (
   canvas_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  value_json TEXT NOT NULL, PRIMARY KEY(canvas_id, kind, id));
```

## collections

```sql
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  );
```

## derived_records

```sql
CREATE TABLE derived_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  paper_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_hashes_json TEXT NOT NULL CHECK(json_valid(input_hashes_json)),
  pipeline_version TEXT NOT NULL,
  model_version TEXT,
  prompt_version TEXT,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  is_current INTEGER NOT NULL,
  UNIQUE(task_key, revision)
  );
```

## export_runs

```sql
CREATE TABLE export_runs (
  id TEXT NOT NULL,
  format TEXT NOT NULL,
  filename TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  paper_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(id)
  );
```

## file_operations

```sql
CREATE TABLE file_operations (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  paper_row_id INTEGER REFERENCES papers(row_id) ON DELETE CASCADE,
  file_id TEXT REFERENCES stored_files(id) ON DELETE SET NULL,
  from_path TEXT,
  to_path TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
  );
```

## import_runs

```sql
CREATE TABLE import_runs (
  id TEXT NOT NULL,
  input_path TEXT,
  status TEXT NOT NULL,
  target_collection_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  parsed_count INTEGER,
  imported_count INTEGER,
  needs_metadata_count INTEGER,
  rejected_count INTEGER,
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  error TEXT,
  PRIMARY KEY(id)
  );
```


## paper_agent_messages

```sql
CREATE TABLE paper_agent_messages (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES paper_agent_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  thinking TEXT,
  status TEXT NOT NULL CHECK(status IN ('complete', 'streaming', 'error', 'aborted')),
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, message_id),
  UNIQUE(session_id, position)
  );
```

## paper_agent_session_cleanup

```sql
CREATE TABLE paper_agent_session_cleanup (
  session_id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL
  );
```

## paper_agent_sessions

```sql
CREATE TABLE paper_agent_sessions (
  id TEXT PRIMARY KEY,
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('once', 'persistent')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
  );
```

## paper_agent_tool_calls

```sql
CREATE TABLE paper_agent_tool_calls (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES paper_agent_sessions(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  assistant_message_id TEXT,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
  input TEXT,
  output TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(session_id, tool_call_id),
  FOREIGN KEY(session_id, assistant_message_id)
  REFERENCES paper_agent_messages(session_id, message_id) ON DELETE CASCADE
  );
```

## paper_authors

```sql
CREATE TABLE paper_authors (
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  PRIMARY KEY(paper_row_id, position)
  );
```

## paper_collections

```sql
CREATE TABLE paper_collections (
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY(paper_row_id, collection_id)
  );
```

## paper_curation

```sql
CREATE TABLE paper_curation (
  paper_row_id INTEGER PRIMARY KEY REFERENCES papers(row_id) ON DELETE CASCADE,
  screening_status TEXT,
  screening_reason TEXT,
  screening_updated_by TEXT,
  screening_updated_at TEXT,
  reading_status TEXT,
  reading_note TEXT,
  reading_updated_by TEXT,
  reading_updated_at TEXT,
  team_review_status TEXT,
  proposed_by TEXT,
  proposed_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_reason TEXT
  );
```

## paper_discovery_paths

```sql
CREATE TABLE paper_discovery_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  query TEXT,
  provider TEXT,
  seed_paper_id TEXT,
  source_url TEXT,
  note TEXT,
  discovered_at TEXT NOT NULL
  );
```

## paper_links

```sql
CREATE TABLE paper_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  open_access INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(paper_row_id, url)
  );
```

## paper_merges

```sql
CREATE TABLE paper_merges (
  canonical_paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  merged_from_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  PRIMARY KEY(canonical_paper_row_id, merged_from_id)
  );
```

## paper_notes

```sql
CREATE TABLE paper_notes (
  id TEXT PRIMARY KEY,
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
  );
```

## paper_provenance

```sql
CREATE TABLE paper_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  provider_record_id TEXT,
  raw_url TEXT
  );
```

## paper_references

```sql
CREATE TABLE paper_references (
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  referenced_work_id TEXT NOT NULL,
  PRIMARY KEY(paper_row_id, position)
  );
```

## paper_search

```sql
CREATE VIRTUAL TABLE paper_search USING fts5(
  paper_row_id UNINDEXED,
  title,
  authors,
  venue,
  abstract,
  tags,
  identifiers,
  user_notes,
  publication_type,
  tokenize='unicode61 remove_diacritics 2'
  );
```

## paper_tags

```sql
CREATE TABLE paper_tags (
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  PRIMARY KEY(paper_row_id, normalized_tag)
  );
```

## paper_versions

```sql
CREATE TABLE paper_versions (
  id TEXT PRIMARY KEY,
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  publication_version_id TEXT REFERENCES publication_versions(id) ON DELETE SET NULL,
  file_id TEXT NOT NULL UNIQUE REFERENCES stored_files(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  version_kind TEXT,
  version_label TEXT,
  related_version_id TEXT REFERENCES paper_versions(id) ON DELETE SET NULL,
  is_preferred INTEGER NOT NULL DEFAULT 0,
  version_json TEXT NOT NULL CHECK(json_valid(version_json)),
  UNIQUE(paper_row_id, file_id)
  );
```

## papers

```sql
CREATE TABLE papers (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  abstract TEXT,
  year INTEGER,
  venue TEXT,
  venue_rank TEXT,
  publication_type TEXT,
  citation_count INTEGER,
  cited_by_api_url TEXT,
  doi TEXT,
  arxiv_id TEXT,
  openalex_id TEXT,
  semantic_scholar_id TEXT,
  dblp_key TEXT,
  core_id TEXT,
  opencitations_id TEXT,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id)
  );
```

## pdf_materials

```sql
CREATE TABLE pdf_materials (
  id TEXT PRIMARY KEY,
  paper_row_id INTEGER NOT NULL UNIQUE REFERENCES papers(row_id) ON DELETE CASCADE,
  paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  engine TEXT NOT NULL CHECK(engine IN ('mineru')),
  model_version TEXT NOT NULL CHECK(model_version IN ('pipeline', 'vlm')),
  package_sha256 TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  );
```

## possible_duplicates

```sql
CREATE TABLE possible_duplicates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  left_paper_id TEXT NOT NULL,
  right_paper_id TEXT NOT NULL,
  title_similarity REAL NOT NULL,
  reason TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES search_runs(id) ON DELETE CASCADE
  );
```

## publication_versions

```sql
CREATE TABLE publication_versions (
  id TEXT PRIMARY KEY,
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  doi TEXT,
  arxiv_id TEXT,
  is_preferred INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_row_id, kind)
  );
```

## research_canvases

```sql
CREATE TABLE research_canvases (
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY(id)
  );
```

## research_note_folders

```sql
CREATE TABLE research_note_folders (
  folder_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  parent_id TEXT REFERENCES research_note_folders(folder_id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  );
```

## research_note_papers

```sql
CREATE TABLE research_note_papers (
  note_row_id INTEGER NOT NULL REFERENCES research_notes(row_id) ON DELETE CASCADE,
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  added_at TEXT NOT NULL,
  PRIMARY KEY(note_row_id, paper_row_id),
  UNIQUE(note_row_id, position)
  );
```

## research_notes

```sql
CREATE TABLE research_notes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  template_id TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, folder_id TEXT REFERENCES research_note_folders(folder_id) ON DELETE RESTRICT,
  UNIQUE(note_id)
  );
```


## search_failures

```sql
CREATE TABLE search_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  message TEXT NOT NULL,
  retryable INTEGER NOT NULL,
  status_code INTEGER,
  rate_limited INTEGER,
  retry_after TEXT,
  FOREIGN KEY(run_id) REFERENCES search_runs(id) ON DELETE CASCADE
  );
```

## search_run_providers

```sql
CREATE TABLE search_run_providers (
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  position INTEGER NOT NULL,
  source_count INTEGER,
  health_status TEXT,
  record_count INTEGER,
  failure_count INTEGER,
  checked_at TEXT,
  message TEXT,
  retry_after TEXT,
  PRIMARY KEY(run_id, provider),
  FOREIGN KEY(run_id) REFERENCES search_runs(id) ON DELETE CASCADE
  );
```

## search_run_queries

```sql
CREATE TABLE search_run_queries (
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  query TEXT NOT NULL,
  PRIMARY KEY(run_id, position),
  FOREIGN KEY(run_id) REFERENCES search_runs(id) ON DELETE CASCADE
  );
```

## search_run_results

```sql
CREATE TABLE search_run_results (
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  paper_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  PRIMARY KEY(run_id, position),
  FOREIGN KEY(run_id) REFERENCES search_runs(id) ON DELETE CASCADE
  );
```

## search_runs

```sql
CREATE TABLE search_runs (
  id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),
  pages_per_provider INTEGER NOT NULL,
  max_results_per_provider INTEGER NOT NULL,
  deduplicated_count INTEGER NOT NULL,
  corpus_hit_count INTEGER,
  scope TEXT NOT NULL,
  mode TEXT NOT NULL,
  resumed_from_checkpoint INTEGER NOT NULL DEFAULT 0,
  search_plan_json TEXT CHECK(search_plan_json IS NULL OR json_valid(search_plan_json)),
  candidate_table_json TEXT CHECK(candidate_table_json IS NULL OR json_valid(candidate_table_json)),
  run_json TEXT NOT NULL CHECK(json_valid(run_json)),
  PRIMARY KEY(id)
  );
```

## stored_files

```sql
CREATE TABLE stored_files (
  id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
  );
```

## zotero_collection_mappings

```sql
CREATE TABLE zotero_collection_mappings (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  library_id TEXT NOT NULL DEFAULT '0',
  zotero_collection_key TEXT NOT NULL,
  collection_version INTEGER NOT NULL,
  path_json TEXT NOT NULL CHECK(json_valid(path_json)),
  last_synced_at TEXT NOT NULL,
  PRIMARY KEY(collection_id, server_id, library_id),
  UNIQUE(server_id, library_id, zotero_collection_key)
  );
```

## zotero_item_mappings

```sql
CREATE TABLE zotero_item_mappings (
  paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  library_id TEXT NOT NULL DEFAULT '0',
  zotero_item_key TEXT NOT NULL,
  item_version INTEGER NOT NULL,
  last_direction TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  PRIMARY KEY(paper_row_id, server_id, library_id),
  UNIQUE(server_id, library_id, zotero_item_key)
  );
```
