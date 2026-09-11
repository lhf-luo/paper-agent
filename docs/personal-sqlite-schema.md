# Personal SQLite 数据库表说明

`personal.sqlite` 是个人研究工作区数据库，不只是已收藏论文的目录。搜索运行、候选结果和 Provider 失败记录需要持久保存，才能让 `once` 模式的结果在会话结束后继续被筛选并导入个人库。因此，搜索相关表与论文、分类和 PDF 版本表放在同一个数据库中，并统一通过 `namespace_id` 隔离。

SQLite 是这些结构化数据的唯一事实来源。Agent 和用户界面必须通过 Paper Agent 工具、Web API 或存储适配层读写，不能直接执行 SQL 或手工修改数据库。搜索历史按 namespace 保留最近 30 次；它们是可复用研究记录，不是临时诊断日志。

[文档索引](README.md) | [系统指南](system-guide.md) | [个人库说明](libraries.md)

个人库数据库默认位于 `.paper-agent/corpus/personal.sqlite`。全部个人 namespace 共用该数据库，通过 `namespace_id` 隔离数据。PDF 文件本身不写入 SQLite，而是保存在 `.paper-agent/files/personal/<namespace>/<paperId>/`，数据库只保存路径、版本关系和校验信息。

本文与 `src/literature/infrastructure/personal-database-schema.ts` 及其 `personal-schema-*.ts` 模块中的当前建表 SQL 对应。所有时间字段均保存为 ISO 8601 文本；SQLite 中的布尔值使用 `INTEGER`，`0` 表示否，`1` 表示是；名称以 `_json` 结尾的字段必须是合法 JSON。

## schema_migrations

记录已经应用的数据库结构迁移，用于后续升级和校验迁移脚本是否发生变化。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `version` | `INTEGER PRIMARY KEY` | 数据库结构版本号。 |
| `name` | `TEXT NOT NULL` | 迁移名称。 |
| `checksum` | `TEXT NOT NULL` | 迁移定义的 SHA-256，用于识别同版本迁移内容是否变化。 |
| `applied_at` | `TEXT NOT NULL` | 迁移应用时间。 |

## namespaces

保存个人空间。删除 namespace 时，其论文、搜索、文件元数据等关联记录会级联删除。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | namespace 标识，例如 `default`。 |
| `created_at` | `TEXT NOT NULL` | namespace 创建时间。 |
| `updated_at` | `TEXT NOT NULL` | namespace 最近更新时间。 |

## papers

个人库论文主表。常用检索字段被拆成独立列，`record_json` 保留完整 `PaperRecord` 快照，供现有 API 和 Agent 工具组装返回值。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `row_id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 数据库内部论文主键，供关联表使用。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 论文所属 namespace。 |
| `paper_id` | `TEXT NOT NULL` | 业务层论文 ID；与 `namespace_id` 组合唯一。 |
| `title` | `TEXT NOT NULL` | 论文标题。 |
| `normalized_title` | `TEXT NOT NULL` | 规范化标题，用于检索和重复判断。 |
| `abstract` | `TEXT` | 摘要。 |
| `year` | `INTEGER` | 发表年份。 |
| `venue` | `TEXT` | 会议、期刊或其他发表场所。 |
| `venue_rank` | `TEXT` | 发表场所等级，例如 `A`、`B`、`C`。 |
| `publication_type` | `TEXT` | 论文、预印本、期刊文章等文献类型。 |
| `citation_count` | `INTEGER` | 最近一次 Provider 补全得到的引用数。 |
| `cited_by_api_url` | `TEXT` | 获取引用该论文文献的 API 地址。 |
| `doi` | `TEXT` | 规范化 DOI；同一 namespace 内非空值唯一。 |
| `arxiv_id` | `TEXT` | 规范化 arXiv ID；同一 namespace 内非空值唯一。 |
| `openalex_id` | `TEXT` | OpenAlex work ID。 |
| `semantic_scholar_id` | `TEXT` | Semantic Scholar paper ID。 |
| `dblp_key` | `TEXT` | DBLP key。 |
| `core_id` | `TEXT` | CORE 记录 ID。 |
| `opencitations_id` | `TEXT` | OpenCitations 记录 ID。 |
| `record_json` | `TEXT NOT NULL`, `json_valid` | 完整 `PaperRecord` JSON 快照。 |
| `created_at` | `TEXT NOT NULL` | 论文记录创建时间。 |
| `updated_at` | `TEXT NOT NULL` | 论文记录最近更新时间。 |

## paper_authors

保存论文作者及作者顺序。一篇论文的作者由 `position` 从小到大排列。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文内部主键。 |
| `position` | `INTEGER NOT NULL` | 作者顺序，从 `0` 开始；与 `paper_row_id` 组成主键。 |
| `name` | `TEXT NOT NULL` | 原始作者姓名。 |
| `normalized_name` | `TEXT NOT NULL`, 已建索引 | 规范化作者姓名，用于搜索和匹配。 |

## paper_links

保存论文主页、DOI、在线 PDF、Artifact 等链接。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 链接内部主键。 |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文。 |
| `url` | `TEXT NOT NULL` | 链接地址；同一论文内不可重复。 |
| `kind` | `TEXT NOT NULL` | 链接类型，如 `landing`、`pdf`、`doi`、`artifact`、`other`。 |
| `open_access` | `INTEGER` | 是否为开放访问链接；允许未知。 |
| `created_at` | `TEXT NOT NULL` | 链接写入时间。 |

## paper_provenance

保存论文元数据来自哪个 Provider、使用了什么查询以及何时获取，形成可追溯来源链。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 来源记录内部主键。 |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文。 |
| `provider` | `TEXT NOT NULL` | Provider 名称，如 `openalex`、`crossref`、`local-pdf`。 |
| `query` | `TEXT NOT NULL` | 产生该来源记录的查询或导入动作。 |
| `retrieved_at` | `TEXT NOT NULL` | 数据获取时间。 |
| `provider_record_id` | `TEXT` | Provider 原始记录 ID，可用于精确去重。 |
| `raw_url` | `TEXT` | Provider 请求地址、原始页面或本地来源路径。 |

## paper_discovery_paths

记录论文是如何被发现的，例如关键词搜索、参考文献扩展、引用扩展或手工种子。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 发现路径内部主键。 |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文。 |
| `kind` | `TEXT NOT NULL` | 发现方式，如 `keyword-search`、`reference-expansion`。 |
| `query` | `TEXT` | 发现该论文时使用的查询。 |
| `provider` | `TEXT` | 执行发现的 Provider。 |
| `seed_paper_id` | `TEXT` | 引用扩展或相似论文扩展的种子论文 ID。 |
| `source_url` | `TEXT` | 发现来源页面或接口地址。 |
| `note` | `TEXT` | 补充说明。 |
| `discovered_at` | `TEXT NOT NULL` | 发现时间。 |

## paper_references

保存论文参考文献列表中的 work ID 和原始顺序。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 引用其他工作的论文。 |
| `position` | `INTEGER NOT NULL` | 参考文献顺序；与 `paper_row_id` 组成主键。 |
| `referenced_work_id` | `TEXT NOT NULL` | 被引用 work 的外部或系统 ID，不要求已存在于个人库。 |

## paper_merges

保存精确去重产生的合并历史，便于追踪规范论文记录曾吸收过哪些 ID。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `canonical_paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 合并后的规范论文。 |
| `merged_from_id` | `TEXT NOT NULL` | 被合并的旧论文 ID；与规范论文组成主键。 |
| `reason` | `TEXT NOT NULL` | 合并原因，例如 `exact-identity`。 |
| `merged_at` | `TEXT NOT NULL` | 合并记录写入时间。 |

## collections

保存个人库分类。`parent_id` 允许构成分类树；同一 namespace、同一父分类下名称唯一。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | 分类 ID。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 分类所属 namespace。 |
| `name` | `TEXT NOT NULL` | 分类名称。 |
| `parent_id` | `TEXT`, FK `collections.id`, `ON DELETE SET NULL` | 父分类 ID；应用层校验同一 namespace，并阻止自身引用和循环层级。 |
| `created_at` | `TEXT NOT NULL` | 分类创建时间。 |
| `updated_at` | `TEXT NOT NULL` | 分类最近更新时间。 |

## paper_collections

论文与分类的多对多关联表。一篇论文可以属于多个分类。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 论文内部主键。 |
| `collection_id` | `TEXT NOT NULL`, FK `collections.id`, `ON DELETE CASCADE` | 分类 ID；与 `paper_row_id` 组成主键。 |
| `added_at` | `TEXT NOT NULL` | 论文加入分类的时间。 |

## paper_tags

保存论文标签，并通过规范化标签避免同一论文出现仅大小写不同的重复标签。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文。 |
| `tag` | `TEXT NOT NULL` | 用户看到的原始标签。 |
| `normalized_tag` | `TEXT NOT NULL` | 规范化标签；与 `paper_row_id` 组成主键。 |

## paper_notes

保存用户对论文添加的个人笔记。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | 数据库笔记 ID，写入时包含 namespace 前缀以避免跨空间冲突。 |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文。 |
| `text` | `TEXT NOT NULL` | 笔记正文。 |
| `author` | `TEXT NOT NULL` | 笔记作者或操作者标识。 |
| `created_at` | `TEXT NOT NULL` | 笔记创建时间。 |

## paper_curation

保存一篇论文当前的筛选、阅读和团队审核状态。每篇论文最多一行。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `paper_row_id` | `INTEGER PRIMARY KEY`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文，同时作为主键。 |
| `screening_status` | `TEXT` | 筛选状态，如 `unreviewed`、`include`、`maybe`、`exclude`。 |
| `screening_reason` | `TEXT` | 筛选理由。 |
| `screening_updated_by` | `TEXT` | 最近修改筛选状态的操作者。 |
| `screening_updated_at` | `TEXT` | 筛选状态更新时间。 |
| `reading_status` | `TEXT` | 阅读状态，如 `unread`、`queued`、`reading`、`read`、`skimmed`。 |
| `reading_note` | `TEXT` | 阅读状态附带说明。 |
| `reading_updated_by` | `TEXT` | 最近修改阅读状态的操作者。 |
| `reading_updated_at` | `TEXT` | 阅读状态更新时间。 |
| `team_review_status` | `TEXT` | 团队审核状态，如 `personal`、`team-proposed`、`team-approved`、`team-rejected`。 |
| `proposed_by` | `TEXT` | 团队提议人。 |
| `proposed_at` | `TEXT` | 团队提议时间。 |
| `reviewed_by` | `TEXT` | 团队审核人。 |
| `reviewed_at` | `TEXT` | 团队审核时间。 |
| `review_reason` | `TEXT` | 团队审核理由。 |

## stored_files

保存磁盘文件元数据。文件内容位于可读目录中，SHA-256 不参与正常文件名生成。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | 文件记录 ID。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 文件所属 namespace。 |
| `relative_path` | `TEXT NOT NULL UNIQUE` | 相对于 `.paper-agent/` 数据根目录的文件路径。 |
| `filename` | `TEXT NOT NULL` | 当前可读文件名。 |
| `original_filename` | `TEXT NOT NULL` | 下载、上传或迁移时的原始文件名。 |
| `sha256` | `TEXT NOT NULL`, 已建普通索引 | 内容校验值，用于完整性验证和精确重复检测。 |
| `bytes` | `INTEGER NOT NULL` | 文件字节数。 |
| `content_type` | `TEXT NOT NULL` | MIME 类型，PDF 通常为 `application/pdf`。 |
| `created_at` | `TEXT NOT NULL` | 文件记录创建时间。 |
| `verified_at` | `TEXT NOT NULL` | 最近完成内容校验的时间。 |

## paper_versions

关联论文和磁盘 PDF 文件，保存版本类型、来源地址和首选状态。同一论文重复保存相同文件内容时不会新增版本。

PDF2zh Next 生成的译文也使用本表：`version_kind` 为 `translation`，`related_version_id` 指向原文版本，`version_json` 记录翻译引擎、版本、模型标识、源语言、目标语言和单语/双语模式。API 密钥和译文正文不写入 SQLite；译文 PDF 仍由 `stored_files` 指向磁盘上的可读文件。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | PDF 版本 ID。 |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文。 |
| `file_id` | `TEXT NOT NULL UNIQUE`, FK `stored_files.id`, `ON DELETE CASCADE` | 对应磁盘文件记录。 |
| `source_url` | `TEXT NOT NULL` | 最初请求或导入的来源地址。 |
| `final_url` | `TEXT NOT NULL` | 重定向后最终地址；本地文件使用 `file` URL。 |
| `retrieved_at` | `TEXT NOT NULL` | PDF 获取时间。 |
| `version_kind` | `TEXT` | 版本类型：`published`、`preprint`、`supplement` 或 `unknown`。 |
| `version_label` | `TEXT` | 可选的人类可读版本标签。 |
| `related_version_id` | `TEXT`, FK `paper_versions.id`, `ON DELETE SET NULL` | 相关版本，例如补充材料对应的主版本。 |
| `is_preferred` | `INTEGER NOT NULL DEFAULT 0` | 是否为该论文的首选版本。 |
| `version_json` | `TEXT NOT NULL`, `json_valid` | 完整 `PaperVersion` JSON 快照。 |

## pdf_materials

记录每篇个人库论文当前可用的 MinerU 全文解析材料。正文、图片和 JSON 文件保存在论文目录下的 `mineru/`，数据库只保存索引与校验信息；同一论文最多保留一条当前记录，重新生成成功后原子替换。生成中、失败等临时状态复用 `background_jobs`，不另建状态表。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | 解析材料记录 ID。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 所属个人空间。 |
| `paper_row_id` | `INTEGER NOT NULL UNIQUE`, FK `papers.row_id`, `ON DELETE CASCADE` | 所属论文；保证每篇论文只有一份当前材料。 |
| `paper_version_id` | `TEXT NOT NULL`, FK `paper_versions.id`, `ON DELETE CASCADE` | 生成材料所依据的本地 PDF 版本。 |
| `source_sha256` | `TEXT NOT NULL` | 源 PDF 内容校验值，用于判断材料是否过期。 |
| `relative_path` | `TEXT NOT NULL UNIQUE` | 相对运行数据目录的材料目录路径。 |
| `engine` | `TEXT NOT NULL` | 当前固定为 `mineru`。 |
| `model_version` | `TEXT NOT NULL` | MinerU 解析模型：`vlm` 或 `pipeline`。 |
| `package_sha256` | `TEXT NOT NULL` | MinerU 原始 ZIP 包的 SHA-256。 |
| `content_sha256` | `TEXT NOT NULL` | 规范化 `full.md` 的 SHA-256。 |
| `page_count` | `INTEGER NOT NULL` | 从 `content_list.json` 得到的物理页数。 |
| `file_count` | `INTEGER NOT NULL` | 当前材料目录中的文件数量。 |
| `bytes` | `INTEGER NOT NULL` | 当前材料目录的总字节数。 |
| `created_at` | `TEXT NOT NULL` | 记录首次创建时间。 |
| `updated_at` | `TEXT NOT NULL` | 最近一次成功生成时间。 |

## file_operations

记录 PDF 重命名、迁移等文件操作，使进程中断后能够检查并恢复未完成操作。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | 文件操作 ID。 |
| `operation` | `TEXT NOT NULL` | 操作类型，目前主要为 `rename`。 |
| `paper_row_id` | `INTEGER`, FK `papers.row_id`, `ON DELETE CASCADE` | 相关论文；允许为空。 |
| `file_id` | `TEXT`, FK `stored_files.id`, `ON DELETE SET NULL` | 相关文件；文件记录删除后保留操作历史。 |
| `from_path` | `TEXT` | 操作前路径。 |
| `to_path` | `TEXT NOT NULL` | 目标路径。 |
| `status` | `TEXT NOT NULL` | `pending`、`completed` 或 `failed`。 |
| `error` | `TEXT` | 失败原因。 |
| `created_at` | `TEXT NOT NULL` | 操作创建时间。 |
| `completed_at` | `TEXT` | 操作完成或失败确认时间。 |

## zotero_item_mappings

记录个人库论文与某个本机 Zotero 数据库条目的稳定对应关系。删除个人库论文或 namespace 时映射自动删除，不会删除 Zotero 条目。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 个人库 namespace。 |
| `paper_row_id` | `INTEGER NOT NULL`, FK `papers.row_id`, `ON DELETE CASCADE` | 个人库论文内部主键。 |
| `server_id` | `TEXT NOT NULL` | Zotero Local API 返回的数据库实例 ID。 |
| `library_id` | `TEXT NOT NULL DEFAULT '0'` | Zotero 用户文库 ID；当前仅支持 `0`。 |
| `zotero_item_key` | `TEXT NOT NULL` | Zotero 文献父条目的稳定 key。 |
| `item_version` | `INTEGER NOT NULL` | 最近同步时的 Zotero 本地对象版本。 |
| `last_direction` | `TEXT NOT NULL` | 最近方向：`zotero-to-personal` 或 `personal-to-zotero`。 |
| `last_synced_at` | `TEXT NOT NULL` | 最近成功同步时间。 |

主键为 `(namespace_id, paper_row_id, server_id, library_id)`；同一 Zotero 条目在相同 namespace 和 Server ID 下只能映射一篇论文。

## zotero_collection_mappings

记录个人库分类与 Zotero 分类的对应关系及同步时的完整路径。删除个人库分类时映射级联删除，不会删除 Zotero 分类。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 个人库 namespace。 |
| `collection_id` | `TEXT NOT NULL`, FK `collections.id`, `ON DELETE CASCADE` | 个人库分类 ID。 |
| `server_id` | `TEXT NOT NULL` | Zotero 数据库实例 ID。 |
| `library_id` | `TEXT NOT NULL DEFAULT '0'` | Zotero 用户文库 ID；当前仅支持 `0`。 |
| `zotero_collection_key` | `TEXT NOT NULL` | Zotero 分类 key。 |
| `collection_version` | `INTEGER NOT NULL` | 最近同步时的 Zotero 分类版本。 |
| `path_json` | `TEXT NOT NULL`, `json_valid` | 从根分类到当前分类的名称数组。 |
| `last_synced_at` | `TEXT NOT NULL` | 最近成功同步时间。 |

主键为 `(namespace_id, collection_id, server_id, library_id)`；同一 Zotero 分类在相同 namespace 和 Server ID 下只能映射一个个人库分类。

## search_runs

保存一次完整文献搜索的主记录和兼容快照。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT NOT NULL` | 搜索运行 ID；与 `namespace_id` 组成主键。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 搜索所属 namespace。 |
| `started_at` | `TEXT NOT NULL` | 搜索开始时间。 |
| `completed_at` | `TEXT NOT NULL` | 搜索完成时间。 |
| `filters_json` | `TEXT NOT NULL`, `json_valid` | 年份、作者、venue、开放访问等过滤条件。 |
| `pages_per_provider` | `INTEGER NOT NULL` | 每个 Provider 请求页数。 |
| `max_results_per_provider` | `INTEGER NOT NULL` | 每个 Provider 最大候选数。 |
| `deduplicated_count` | `INTEGER NOT NULL` | 去重后的候选论文数。 |
| `corpus_hit_count` | `INTEGER` | 与已有个人库匹配的论文数。 |
| `scope` | `TEXT NOT NULL` | 搜索作用域，例如 `personal`。 |
| `mode` | `TEXT NOT NULL` | 生命周期模式：`once` 或 `persistent`。 |
| `resumed_from_checkpoint` | `INTEGER NOT NULL DEFAULT 0` | 是否从 checkpoint 恢复。 |
| `search_plan_json` | `TEXT`, 可空且必须为合法 JSON | 结构化搜索计划。 |
| `candidate_table_json` | `TEXT`, 可空且必须为合法 JSON | 候选论文表快照。 |
| `run_json` | `TEXT NOT NULL`, `json_valid` | 完整 `SearchRun` JSON 快照。 |

## search_run_queries

保存一次搜索中的查询变体及顺序。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `namespace_id` | `TEXT NOT NULL`, 复合 FK `search_runs` | 搜索所属 namespace。 |
| `run_id` | `TEXT NOT NULL`, 复合 FK `search_runs`, `ON DELETE CASCADE` | 搜索运行 ID。 |
| `position` | `INTEGER NOT NULL` | 查询顺序；与 namespace、run ID 组成主键。 |
| `query` | `TEXT NOT NULL` | 实际发送给 Provider 的查询文本。 |

## search_run_providers

保存每次搜索中各 Provider 的执行顺序、返回数量和健康状态。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `namespace_id` | `TEXT NOT NULL`, 复合 FK `search_runs` | 搜索所属 namespace。 |
| `run_id` | `TEXT NOT NULL`, 复合 FK `search_runs`, `ON DELETE CASCADE` | 搜索运行 ID。 |
| `provider` | `TEXT NOT NULL` | Provider 名称；与 namespace、run ID 组成主键。 |
| `position` | `INTEGER NOT NULL` | Provider 执行或展示顺序。 |
| `source_count` | `INTEGER` | 该 Provider 贡献的候选数量。 |
| `health_status` | `TEXT` | `healthy`、`partial`、`rate-limited`、`failed` 或 `not-run`。 |
| `record_count` | `INTEGER` | 健康快照中的成功记录数。 |
| `failure_count` | `INTEGER` | 健康快照中的失败数。 |
| `checked_at` | `TEXT` | Provider 状态检查时间。 |
| `message` | `TEXT` | 状态或错误摘要。 |
| `retry_after` | `TEXT` | 限流后的建议重试时间。 |

## search_run_results

保存一次搜索的全部候选论文 JSON 快照，确保 `once` 模式结果之后仍可被选择并导入个人库。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `namespace_id` | `TEXT NOT NULL`, 复合 FK `search_runs` | 搜索所属 namespace。 |
| `run_id` | `TEXT NOT NULL`, 复合 FK `search_runs`, `ON DELETE CASCADE` | 搜索运行 ID。 |
| `position` | `INTEGER NOT NULL` | 结果顺序；与 namespace、run ID 组成主键。 |
| `paper_id` | `TEXT NOT NULL` | 候选论文业务 ID，不要求已存入 `papers`。 |
| `record_json` | `TEXT NOT NULL`, `json_valid` | 候选论文完整 `PaperRecord` 快照。 |

## search_failures

保存 Provider 查询失败、限流和重试信息。单个 Provider 失败不会抹掉其他 Provider 的成功结果。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 失败记录内部主键。 |
| `namespace_id` | `TEXT NOT NULL`, 复合 FK `search_runs` | 搜索所属 namespace。 |
| `run_id` | `TEXT NOT NULL`, 复合 FK `search_runs`, `ON DELETE CASCADE` | 搜索运行 ID。 |
| `provider` | `TEXT NOT NULL` | 失败的 Provider。 |
| `query` | `TEXT NOT NULL` | 失败时执行的查询。 |
| `message` | `TEXT NOT NULL` | 错误信息。 |
| `retryable` | `INTEGER NOT NULL` | 是否适合重试。 |
| `status_code` | `INTEGER` | HTTP 状态码。 |
| `rate_limited` | `INTEGER` | 是否属于限流。 |
| `retry_after` | `TEXT` | Provider 返回或系统计算的重试时间。 |

## possible_duplicates

保存相似标题产生的疑似重复提示。该表只用于人工复核，不会自动合并论文。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 疑似重复记录内部主键。 |
| `namespace_id` | `TEXT NOT NULL`, 复合 FK `search_runs` | 搜索所属 namespace。 |
| `run_id` | `TEXT NOT NULL`, 复合 FK `search_runs`, `ON DELETE CASCADE` | 产生提示的搜索运行。 |
| `left_paper_id` | `TEXT NOT NULL` | 比较左侧论文 ID。 |
| `right_paper_id` | `TEXT NOT NULL` | 比较右侧论文 ID。 |
| `title_similarity` | `REAL NOT NULL` | 标题相似度。 |
| `reason` | `TEXT NOT NULL` | 提示原因，目前为 `similar-title`。 |

## derived_records

保存摘要、分析缓存等机器派生结果的历史版本。调研笔记正文不存放在此表。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 派生记录内部主键。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 所属 namespace。 |
| `task_key` | `TEXT NOT NULL` | 由输入材料和处理配置决定的稳定任务键。 |
| `revision` | `INTEGER NOT NULL` | 同一任务键的版本号；与 namespace、task key 组合唯一。 |
| `paper_id` | `TEXT NOT NULL` | 关联论文业务 ID。 |
| `operation` | `TEXT NOT NULL` | 派生操作类型。 |
| `input_hashes_json` | `TEXT NOT NULL`, `json_valid` | 输入材料 SHA-256 列表。 |
| `pipeline_version` | `TEXT NOT NULL` | 处理流水线版本。 |
| `model_version` | `TEXT` | 生成结果使用的模型版本。 |
| `prompt_version` | `TEXT` | 使用的 prompt 版本。 |
| `config_json` | `TEXT NOT NULL`, `json_valid` | 规范化处理配置。 |
| `result_json` | `TEXT NOT NULL`, `json_valid` | 派生结果正文。 |
| `record_json` | `TEXT NOT NULL`, `json_valid` | 完整 `DerivedRecord` 快照。 |
| `created_by` | `TEXT` | 创建者或 Agent 标识。 |
| `created_at` | `TEXT NOT NULL` | 创建时间。 |
| `is_current` | `INTEGER NOT NULL` | 是否为该任务键当前版本；同一 namespace 和 task key 只能有一行当前版本。 |

## import_runs

保存本地 PDF、BibTeX 或 JSON 导入操作及导入报告。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT NOT NULL` | 导入运行 ID；与 `namespace_id` 组成主键。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 导入目标 namespace。 |
| `input_path` | `TEXT` | 导入文件或目录路径。 |
| `status` | `TEXT NOT NULL` | 导入状态，如 `completed`、`failed`。 |
| `target_collection_id` | `TEXT` | 导入目标分类 ID。当前未设置外键，以保留分类删除后的历史。 |
| `started_at` | `TEXT` | 导入开始时间。 |
| `completed_at` | `TEXT` | 导入完成时间。 |
| `parsed_count` | `INTEGER` | 成功解析的文献数。 |
| `imported_count` | `INTEGER` | 实际保存的文献数。 |
| `needs_metadata_count` | `INTEGER` | 因缺少标题或作者而暂停的文件数。 |
| `rejected_count` | `INTEGER` | 被拒绝条目数。 |
| `report_json` | `TEXT NOT NULL`, `json_valid` | 完整导入报告，包括 warning、疑似重复和拒绝原因。 |
| `error` | `TEXT` | 批次失败信息。 |

## export_runs

保存个人库导出历史，不保存导出文件正文。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT NOT NULL` | 导出运行 ID；与 `namespace_id` 组成主键。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 导出来源 namespace。 |
| `format` | `TEXT NOT NULL` | 导出格式：`markdown`、`csv`、`bibtex` 或 `json`。 |
| `filename` | `TEXT NOT NULL` | 导出文件名。 |
| `relative_path` | `TEXT NOT NULL` | 相对于数据根目录的导出文件路径。 |
| `paper_count` | `INTEGER NOT NULL` | 本次导出的论文数。 |
| `created_at` | `TEXT NOT NULL` | 导出时间。 |

## research_note_folders

保存调研笔记的多级文件夹树。文件夹同时对应 `.paper-agent/notes/{namespace}/` 下的真实目录。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `folder_id` | `TEXT PRIMARY KEY` | 稳定文件夹 ID。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 所属个人空间。 |
| `name`, `normalized_name` | `TEXT NOT NULL` | 展示名称及同级重名校验值。 |
| `parent_id` | FK `research_note_folders.folder_id`, `ON DELETE RESTRICT` | 上级文件夹；`NULL` 表示根目录。 |
| `relative_path` | `TEXT NOT NULL UNIQUE` | 真实目录相对于运行数据目录的路径。 |
| `created_at`, `updated_at` | `TEXT NOT NULL` | 创建和最近修改时间。 |

文件夹可任意嵌套，但不能移入自身或后代。非空文件夹禁止删除；重命名或移动时同步更新后代目录和笔记路径。

## research_notes

保存调研笔记的索引、修订号和正文校验值。Markdown 正文不进入 SQLite，实际内容位于 `.paper-agent/notes/{namespace}/`。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `row_id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 内部主键。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 所属个人空间。 |
| `note_id` | `TEXT NOT NULL` | 稳定的对外笔记 ID；与 namespace 组成唯一键。 |
| `title` | `TEXT NOT NULL` | 笔记名称。 |
| `relative_path` | `TEXT NOT NULL UNIQUE` | Markdown 文件相对于运行数据目录的路径。 |
| `folder_id` | FK `research_note_folders.folder_id`, `ON DELETE RESTRICT` | 所属文件夹；`NULL` 表示直接位于笔记根目录。 |
| `template_id` | `TEXT` | 创建时使用的模板 ID；空白笔记为 `NULL`。 |
| `revision` | `INTEGER NOT NULL` | 每次成功保存正文、标题、目录或论文关联后递增。 |
| `content_hash` | `TEXT NOT NULL` | 当前 Markdown 正文的 SHA-256，用于外部修改冲突检查。 |
| `created_at`, `updated_at` | `TEXT NOT NULL` | 创建和最近保存时间。 |

笔记正文始终读取实际 Markdown 文件。进入调研区、窗口重新获得焦点、手动刷新或 Agent 查询笔记时，系统会扫描笔记目录并对账：外部新建的 Markdown 自动建立索引，移动、改名或编辑会更新路径、标题、修订号和哈希，外部删除会清除索引及论文关联。系统不会用空文件覆盖缺失正文。

Paper Agent 创建的文件名包含稳定的笔记 ID 短后缀。外部移动或改名时保留该后缀，可以可靠保留原笔记 ID 和论文关联；若后缀被删除，仅在内容哈希唯一且正文未同时变化时尝试识别同一笔记。

外部新建的 Markdown 初次索引时没有论文关联；可在笔记“修改”卡片中补充一个或多个 `paper_id`。正文和目录结构可以由 Obsidian 等外部编辑器维护，论文关联仍由 SQLite 管理。

## research_note_papers

保存调研笔记与个人库论文的多对多关系。笔记可以不关联论文，也可以关联任意多篇同 namespace 论文。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `note_row_id` | FK `research_notes.row_id`, `ON DELETE CASCADE` | 所属笔记；与 `paper_row_id` 组成主键。 |
| `paper_row_id` | FK `papers.row_id`, `ON DELETE CASCADE` | 关联的个人库论文。删除论文时只删除关系，笔记继续保留。 |
| `position` | `INTEGER NOT NULL` | 论文在笔记中的展示顺序。 |
| `added_at` | `TEXT NOT NULL` | 建立关联的时间。 |

跨 namespace 关联会被应用层和 Repository 拒绝。删除笔记会级联删除全部论文关系及对应 Markdown 文件。

## artifact_manifests

保存论文 Artifact 发现和获取清单，记录 PDF 指纹及完整 manifest 快照。`acquire_paper_artifacts` 在提供 `paper_id` 和 namespace 时自动写入或更新；`build_paper_package` 自动读取对应论文的记录，不需要手工传递文件路径。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT NOT NULL` | 由 PDF SHA-256 派生的稳定 Artifact manifest ID；与 `namespace_id` 组成主键。 |
| `namespace_id` | `TEXT NOT NULL`, FK `namespaces.id`, `ON DELETE CASCADE` | 所属 namespace。 |
| `paper_id` | `TEXT` | 关联论文业务 ID；写入前验证论文存在于同一 namespace，删除论文时同步删除。 |
| `pdf_sha256` | `TEXT` | 产生该清单的 PDF SHA-256。 |
| `manifest_json` | `TEXT NOT NULL`, `json_valid` | 完整 Artifact manifest JSON。 |
| `discovered_at` | `TEXT NOT NULL` | Artifact 首次发现时间。 |
| `updated_at` | `TEXT NOT NULL` | 清单最近更新时间。 |

## paper_agent_sessions

保存 PDF 阅读工作台中的论文专属 Agent 会话。该类会话按论文和 namespace 隔离，不出现在主 Agent 页的普通会话列表中。删除论文时会级联删除会话记录。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Agent 会话 ID。 |
| `namespace_id` | FK `namespaces.id`, `ON DELETE CASCADE` | 所属个人空间。 |
| `paper_row_id` | FK `papers.row_id`, `ON DELETE CASCADE` | 绑定的个人库论文。 |
| `title` | `TEXT NOT NULL` | 会话标题。 |
| `mode` | 受限 `TEXT` | `once` 或 `persistent`；阅读器创建的会话使用 `persistent`。 |
| `created_at`, `updated_at` | `TEXT NOT NULL` | 创建和最近更新时间。 |
| `last_opened_at` | `TEXT NOT NULL` | 最近打开时间，供会话排序使用。 |

## paper_agent_messages

保存论文会话中的用户消息、助手回复和思考文本。数据库只保留当前会话内容，不额外复制历史版本。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `row_id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 数据库内部主键。 |
| `session_id` | FK `paper_agent_sessions.id`, `ON DELETE CASCADE` | 所属论文会话。 |
| `message_id` | `TEXT NOT NULL` | 会话内消息 ID；与 `session_id` 组合唯一。 |
| `position` | `INTEGER NOT NULL` | 消息顺序；同一会话内唯一。 |
| `role` | 受限 `TEXT` | `user` 或 `assistant`。 |
| `content` | `TEXT NOT NULL` | 消息正文。 |
| `thinking` | `TEXT` | 可选的模型思考文本。 |
| `status` | 受限 `TEXT` | `complete`、`streaming`、`error` 或 `aborted`。 |
| `error` | `TEXT` | 该消息的可选错误说明。 |
| `created_at` | `TEXT NOT NULL` | 消息创建时间。 |

## paper_agent_tool_calls

保存论文会话中的工具调用，并通过 `assistant_message_id` 归属到触发它的助手回复。运行或失败调用在界面默认展开，成功调用默认折叠。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `row_id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 数据库内部主键。 |
| `session_id` | FK `paper_agent_sessions.id`, `ON DELETE CASCADE` | 所属论文会话。 |
| `tool_call_id` | `TEXT NOT NULL` | 会话内工具调用 ID；与 `session_id` 组合唯一。 |
| `assistant_message_id` | 可空复合 FK `paper_agent_messages` | 对应的助手回复；旧记录无法判断时可为空。 |
| `position` | `INTEGER NOT NULL` | 工具调用顺序。 |
| `name` | `TEXT NOT NULL` | 工具名称。 |
| `status` | 受限 `TEXT` | `running`、`succeeded` 或 `failed`。 |
| `input`, `output` | `TEXT` | 脱敏并按上限截断的输入和输出。 |
| `started_at`, `finished_at` | 时间字段 | 开始时间和可选完成时间。 |

## paper_agent_session_cleanup

记录因论文级联删除而待清理的运行时会话文件。后台处理完成后立即删除对应行，不作为操作历史长期保留。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `session_id` | `TEXT PRIMARY KEY` | 待清理的论文会话 ID。 |
| `requested_at` | `TEXT NOT NULL` | SQLite 触发器登记清理请求的时间。 |

论文会话的消息和工具记录以 SQLite 为事实来源。`.paper-agent/web-agent-memory/pi-sessions/` 中的 Pi JSONL 仅供模型运行时恢复上下文；删除会话或论文时会同步清理，不应被当作展示数据或长期数据库。

## paper_search

FTS5 全文搜索虚拟表。该表由论文写入流程同步更新，不应由用户直接修改。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `paper_row_id` | FTS5 `UNINDEXED` | 对应 `papers.row_id`，仅用于定位记录。 |
| `namespace_id` | FTS5 `UNINDEXED` | 所属 namespace，仅用于过滤。 |
| `title` | FTS5 索引列 | 论文标题。 |
| `authors` | FTS5 索引列 | 拼接后的作者姓名。 |
| `venue` | FTS5 索引列 | 发表场所。 |
| `abstract` | FTS5 索引列 | 摘要。 |
| `tags` | FTS5 索引列 | 用户标签。 |
| `identifiers` | FTS5 索引列 | 论文 ID、DOI、arXiv ID 等标识符。 |
| `user_notes` | FTS5 索引列 | 用户笔记。 |
| `publication_type` | FTS5 索引列 | 文献类型。 |

分词器为 `unicode61 remove_diacritics 2`，支持 Unicode 文本并在搜索时消除拉丁字符变音差异。

## legacy_migrations

记录每个 namespace 从旧 JSON/SHA 目录迁移到 SQLite 的状态。

| 字段 | 类型与约束 | 说明 |
| --- | --- | --- |
| `namespace_id` | `TEXT PRIMARY KEY` | 被迁移的 namespace。 |
| `status` | `TEXT NOT NULL` | `running`、`completed` 或 `failed`。 |
| `backup_path` | `TEXT` | 迁移前备份目录。 |
| `started_at` | `TEXT NOT NULL` | 迁移开始时间。 |
| `completed_at` | `TEXT` | 迁移完成或失败确认时间。 |
| `error` | `TEXT` | 迁移失败原因。 |

## 关系与删除规则

- `namespaces` 是个人库数据的顶层所有者，删除 namespace 会级联删除其论文、搜索、文件元数据和派生记录。
- `papers.row_id` 是论文关联表使用的内部主键；外部 API 和 Agent 工具继续使用 `paper_id`。
- 删除论文会级联删除作者、链接、来源、发现路径、分类关系、标签、笔记、整理状态和 PDF 版本关系；存储层随后删除对应磁盘文件。
- 删除论文还会级联删除 `paper_agent_sessions`、消息与工具记录；清理队列随后删除对应 Pi JSONL、上传文件和会话结果文档。
- 通过系统删除分类时会递归删除整棵分类树及对应 `paper_collections` 关系，但不会删除论文及其 PDF、Artifact 或调研笔记。
- `search_runs` 删除时会级联删除查询、Provider 状态、候选结果、失败和疑似重复记录。
- `record_json`、`version_json` 和 `run_json` 是兼容快照，结构化列与关联表用于约束、查询和后续演进。
