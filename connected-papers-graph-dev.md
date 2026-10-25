# 论文关系图谱渲染系统 —— 开发文档

> 目标产物：一张"以某篇种子论文为中心、展示其相关论文网络"的交互式图谱页面 / 导出图片（参考形态见 Connected Papers 的 `/main/<paperId>/graph` 页面截图）。
>
> 本文只讨论**如何从一篇论文生成这张图**：需要哪些输入、要写哪些模块、每个模块怎么实现、图片怎么导出。

版本：v1 草稿 · 适用范围：Web 应用（也可复用于 Electron / 服务端渲染截图）

---

## 0. 先明确产物

截图里的页面 = 4 个视觉区域 + 1 个交互层。开发时要拆成独立单元，否则后面一定返工。

| 区域 | 内容 | 是否属于"图" |
|---|---|---|
| Header | 搜索框、Share/Follow/About/Pricing/Log in | 否（页面外壳） |
| 标题栏 | 种子论文标题、Prior works / Derivative works / List view / Filters / More | 否（视图切换） |
| 左侧列表 | 相关论文卡片：标题、作者、年份徽标 | 是（同一份数据的不同视图） |
| 中间画布 | 力导向图：节点(圆) + 边(细线) + 标签(Author, Year) + 年份色标 | **是（核心）** |
| 右侧详情 | 选中论文：标题、作者、年份+期刊、被引数、Save、Open in [S2/DOI/Scholar]、摘要 | 否（详情面板） |

**最小可交付**：给定一篇论文 → 输出一张 SVG/PNG，包含画布 + 节点 + 边 + 标签 + 年份图例。

---

## 1. 输入清单

### 1.1 一句话回答"除了论文还需要什么"

> 你有的论文只提供了 **1 个种子**。这张图还需要四类数据：
> 1. **种子论文的结构化元数据**（标题/作者/年份/期刊/摘要/被引数）；
> 2. **邻居集合**（它引用的、引用它的论文，以及二阶的共同参考文献 / 共同被引）；
> 3. **每一对论文之间的关系强度**（共被引数、文献耦合数、embedding 相似度）；
> 4. **布局与视觉参数**（年份范围、节点半径规则、坐标）。
>
> 加上工程侧：**缓存/版本 id、数据来源许可、导出参数**。

### 1.2 必需输入（缺一不可）

| # | 数据项 | 用途 | 典型来源 | 缺失时降级 |
|---|---|---|---|---|
| 1 | 种子标识（DOI / arXiv ID / PMID / S2 paperId 任一） | 归一化到内部 `paper_id` | 用户粘贴的 URL 或 ID | 不可降级，直接报错 |
| 2 | 种子元数据 `title, authors[], year, venue, abstract` | 标题栏、右侧详情、节点标签 | Semantic Scholar / OpenAlex / Crossref | 标题必需，其余可空 |
| 3 | `references[]`（种子引用的论文 id 列表） | 构建 prior 侧邻居 | S2 `paper/{id}/references`、OpenAlex `referenced_works` | 图退化为只有 derivative 侧 |
| 4 | `citations[]`（引用种子的论文 id 列表） | 构建 derivative 侧邻居 | S2 `paper/{id}/citations`、OpenAlex `cited_by_api_url` | 同上，退化为单侧 |
| 5 | 每个邻居的 `title, authors[], year, venue` | 节点标签、左侧列表 | 批量拉取（S2 batch / OpenAlex works?filter） | 缺年份则无法上色，需兜底灰色 |
| 6 | 关系强度 `weight`（数值） | 边权、布局斥力/引力、剪枝排序 | 由 3+4 自行计算（见 §4） | 可用"共同邻居数"作为唯一权重 |

### 1.3 强烈建议输入（决定图的质量）

| # | 数据项 | 作用 | 来源 |
|---|---|---|---|
| 7 | 二阶共同被引 `common_citations[]` | Derivative works 面板；区分"后续工作" | 对 citations 集合做交集 |
| 8 | 二阶共同参考文献 `common_references[]` | Prior works 面板；区分"基础工作" | 对 references 集合做交集 |
| 9 | `citationCount` / `referenceCount` | 节点半径、相关性排序 | S2 / OpenAlex |
| 10 | `embedding`（标题+摘要向量） | 语义相似度，弥补纯引用的稀疏 | SPECTER2 / OpenAI embeddings / 自建 |
| 11 | `authors[]`（含 id） | 共同作者加权重、节点 hover 信息 | S2 authors |
| 12 | `externalIds`（DOI/arXiv/PMID） | 右侧 "Open in" 链接 | S2 |
| 13 | `openAccessPdf` | 详情面板下载按钮 | S2 / Unpaywall |

### 1.4 工程输入

| # | 数据项 | 说明 |
|---|---|---|
| 14 | `graph_uuid` / `params_version` | 图谱版本；同一论文可有多个版本（重建后 uuid 变化） |
| 15 | 数据集快照时间 | 引文数据会变，必须记录 `data_as_of` |
| 16 | 视觉配置 | 年份色带范围、半径上下限、标签显示阈值、画布比例 |
| 17 | 导出参数 | 尺寸、DPR(2x)、背景色、是否显示图例/标签 |

### 1.5 数据源 API 备忘

```bash
# Semantic Scholar（匿名 1 req/s，生产需 API key）
GET https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/xxxx?fields=title,authors,year,venue,abstract,citationCount,referenceCount,externalIds
GET https://api.semanticscholar.org/graph/v1/paper/{paperId}/references?fields=title,authors,year,venue,citationCount&limit=500
GET https://api.semanticscholar.org/graph/v1/paper/{paperId}/citations?fields=title,authors,year,venue,citationCount&limit=1000
POST https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,authors,year,venue   # body: {"ids":[..]}

# OpenAlex（免费、无 key、有 polite pool）
GET https://api.openalex.org/works/doi:10.1145/xxxx
GET https://api.openalex.org/works?filter=cites:W123456789,per-page=200
# work 对象里：referenced_works[]（它引用的）、cited_by_count、cited_by_api_url

# 其他可选：Crossref（元数据权威）、arXiv（预印本）、OpenCitations（开放引文）
```

**注意**：邻居数量可能上万（高被引论文）。必须分页 + 截断 + 记录"截断事实"，不要静默丢数据。

---

## 2. 系统架构

```
┌──────────────┐
│ 输入：论文 ID │
└──────┬───────┘
       ▼
[1] ID 归一化      ids.ts           DOI/arXiv/PMID/S2 → 内部 paper_id
       ▼
[2] 元数据抓取     sources/*.ts     seed 元数据 + references + citations
       ▼
[3] 邻居扩展       expand.ts        1~2 跳；记录 common_refs / common_cites
       ▼
[4] 相似度打分     similarity.ts    共被引 / 文献耦合 / 作者 / 向量
       ▼
[5] 剪枝与配额     prune.ts         top-k、节点上限、连通性、prior/deriv 分类
       ▼
[6] 布局           layout.ts        力导向，迭代 N 次，输出 (x,y)
       ▼
[7] 序列化         serialize.ts     GraphDoc(JSON) / 可选二进制 CPGR
       ▼
┌────────────────────────────────────────────┐
│ [8] 前端渲染  SVG + d3-force               │
│ [9] 交互      缩放/平移/悬停/选中           │
│ [10] 导出     SVG → PNG（浏览器或 Puppeteer）│
└────────────────────────────────────────────┘
```

服务端推荐做成**异步任务**（不是同步请求）：入队 → 状态机 → 前端轮询。原因：一次构图要几百次 API 调用 + 布局迭代，10~60 秒很常见。

---

## 3. 数据模型

一份 `GraphDoc` 就能驱动全部视图。

```ts
// types/graph.ts
export interface PaperNode {
  paperId: string;          // 内部唯一 id（建议直接用 S2 id 或 DOI 归一化值）
  title: string;
  authors: string[];        // 展示用；完整对象另存
  year: number | null;      // 上色必需；null 时用灰色
  venue: string | null;
  citationCount: number;
  abstract?: string;
  externalIds?: { DOI?: string; ArXiv?: string; PubMed?: string };
  pos: { x: number; y: number };   // 布局结果（归一化到 [0,1] 或画布坐标）
  kind: "seed" | "prior" | "derivative" | "neighbor";
}

export interface PaperEdge {
  source: string;           // paperId
  target: string;
  weight: number;           // 0..1，已归一化
  reason: ("co-citation" | "bibliographic-coupling" | "embedding" | "author")[];
}

export interface GraphDoc {
  graphId: string;          // uuid，用于缓存与版本
  startId: string;          // 种子 paperId
  nodes: PaperNode[];
  edges: PaperEdge[];
  commonCitations: string[];   // → Derivative works
  commonReferences: string[];  // → Prior works
  parameters: {
    paperId: string;
    totalNodes: number;
    numNeighbors: number;     // 每篇保留的邻居数 k
    maxLoad: number;          // 节点上限
    springIterations: number; // 布局迭代次数
    layoutVersion: number;    // 布局算法版本，变了就重算
  };
  meta: {
    dataAsOf: string;         // 数据快照时间
    yearMin: number;
    yearMax: number;
    truncated: boolean;       // 是否发生截断
    sources: string[];        // 使用的数据源，用于署名/合规
  };
}
```

> 设计要点：**布局坐标放进数据里**（`pos`）。这样前端首屏就能成图，导出图片也可确定性复现。

---

## 4. 关系强度计算

三种经典引文相似度，按权重混合：

| 度量 | 定义 | 直觉 |
|---|---|---|
| Co-citation（共被引） | 有多少篇论文同时引用了 A 和 B | 学术圈把它们放在一起讨论 |
| Bibliographic coupling（文献耦合） | A 和 B 引用了多少相同的参考文献 | 用同一批基础工作 |
| Embedding 余弦 | `cos(vec(A), vec(B))` | 主题相近但无引用关系 |

```ts
// similarity.ts
const w = (a: PaperFeatures, b: PaperFeatures) => {
  const coCit   = jaccard(a.citedBy, b.citedBy);        // 或原始计数 / log1p
  const coupling= jaccard(a.references, b.references);
  const cos     = cosine(a.embedding, b.embedding);      // 0..1
  const author  = overlap(a.authorIds, b.authorIds) > 0 ? 1 : 0;
  return clamp01(0.45 * coCit + 0.35 * coupling + 0.20 * cos) * (1 + 0.1 * author);
};
```

- 计数类指标先做 `log1p` 再归一化，否则高被引论文会吞掉所有权重。
- 只在 `|year(A) - year(B)|` 合理范围内连边（可选，避免 1990 与 2025 直接相连）。
- **prior / derivative 判定**（决定节点颜色语义与两个侧栏）：
  - `year < seed.year` 且与种子共享参考文献 → **prior**
  - `year > seed.year` 且与种子共同被引 → **derivative**
  - 其余 → 普通邻居

---

## 5. 剪枝与配额

不剪枝的图必然是一团糊。规则（按序执行）：

1. **单篇邻居数上限** `k = numNeighbors`（建议 5~15）：按 weight 取 top-k。
2. **全局节点上限** `maxLoad`（建议 120~400，SVG 渲染舒适区；>800 改 canvas/WebGL）。
3. **连通性**：从种子出发做 BFS，丢弃孤立子图（否则画布上会出现漂浮孤岛）。
4. **去重**：同一 paperId 多来源出现，保留权重最高的一条边。
5. **二次跳限制**：二阶节点只在"与种子直接相连"或"权重超阈值"时保留。

```ts
// prune.ts
export function prune(doc: GraphDoc, cfg: {k: number; maxLoad: number}) {
  const adj = buildAdjacency(doc.edges);                 // paperId → edges[]
  const keep = new Set<string>([doc.startId]);
  const byWeight = [...doc.edges].sort((a, b) => b.weight - a.weight);
  for (const e of byWeight) {
    if (keep.size >= cfg.maxLoad) break;
    const degA = degreeIn(keep, adj, e.source);
    const degB = degreeIn(keep, adj, e.target);
    if (degA >= cfg.k && degB >= cfg.k) continue;
    keep.add(e.source); keep.add(e.target);
  }
  const nodes = doc.nodes.filter(n => keep.has(n.paperId) || n.kind === "seed");
  const edges = doc.edges.filter(e => keep.has(e.source) && keep.has(e.target));
  const bounded = bfsFromSeed(nodes, edges, doc.startId);  // 丢弃孤岛
  return { ...doc, nodes: bounded.nodes, edges: bounded.edges,
           meta: { ...doc.meta, truncated: keep.size >= cfg.maxLoad } };
}
```

**必须记录截断事实**（`meta.truncated`），并在 UI 上说明"仅展示 top-N 相关论文"，否则会误导用户以为是全集。

---

## 6. 布局

两种做法，推荐 **A 为主 + B 兜底**：

### A. 服务端预算布局（推荐，和参考实现一致）

```ts
// layout.ts
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";

export function layout(doc: GraphDoc, {iterations = 300, seed = 42}) {
  const sim = forceSimulation(doc.nodes as any)
    .randomSource(mulberry32(seed))          // ★ 必须固定种子，保证可复现
    .force("link", forceLink(doc.edges).id(d => d.paperId)
      .strength(e => 0.1 + 0.5 * e.weight)
      .distance(e => 120 - 60 * e.weight))
    .force("charge", forceManyBody().strength(-260))
    .force("center", forceCenter(0, 0))
    .force("collide", forceCollide(d => radiusOf(d) + 6))
    .stop();
  for (let i = 0; i < iterations; i++) sim.tick();
  // 归一化到 [0,1]，前端再乘画布尺寸
  return normalize(normalizeToUnitSquare(doc.nodes));
}
```

- 迭代次数写入 `parameters.springIterations`。
- 布局算法版本变化 → `layoutVersion++` → 缓存失效重算。
- 输出前做 **bounding box 归一化**，避免不同规模图在画布上大小不一。

### B. 前端微调（可选）

拿到 `pos` 后，前端仍跑 ~60~120 tick 的力导向做视觉松弛，让重叠更少。参考实现就是这么做的（服务端给初值，前端 `run_sim()` 收尾）。

> 不要纯前端从随机位置开始算：大图抖动明显，且导出两次结果不一样。

---

## 7. 前端渲染（核心）

### 7.1 DOM 结构（SVG 分层，逐个 `g` 独立重绘）

```html
<svg id="maingraph" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="yearScaleGrad" x1="0%" x2="100%">
      <stop offset="0%"   stop-color="#d8e6e2"/>
      <stop offset="100%" stop-color="#0f4c46"/>
    </linearGradient>
    <filter id="seedGlow">
      <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#7a6ad8" flood-opacity="0.55"/>
    </filter>
  </defs>

  <g id="panplane" transform="translate(0,0) scale(1)">
    <g class="edges">   <!-- 先画边，压在节点下面 -->
      <line x1=".." y1=".." x2=".." y2=".." stroke="#9db3ae" stroke-opacity="0.45" stroke-width="1"/>
    </g>
    <g class="nodes">
      <circle r="11" fill="#2f6d64"/>                                   <!-- 普通节点 -->
      <circle r="13" fill="#0f4c46" filter="url(#seedGlow)"/>           <!-- 种子节点 -->
    </g>
    <g class="labels">
      <text x="0" y="-14" font-size="10" fill="#3c4a48" text-anchor="middle">Zaki, 2026</text>
    </g>
  </g>
</svg>
```

要点：

- **顺序即层级**：edges → nodes → labels，否则线会盖住圆。
- **`#panplane` 一起变换**：缩放/平移只改一个 `transform`，性能好。
- **不要用 `foreignObject`**（导出 PNG 会炸，见 §8）。

### 7.2 视觉规格（对齐截图）

| 元素 | 规格 |
|---|---|
| 画布背景 | `#ffffff`，无边框 |
| 边 | `stroke #9db3ae`，`opacity .35~.5`，`width 1`（缩放时不加粗，或按 `k^0.5` 微调） |
| 节点 | 实心圆，`fill` 由年份映射；`stroke rgba(255,255,255,.7)` 1px 让重叠节点可分辨 |
| 节点半径 | `r = clamp(5, 22, 6 + 4 * log1p(citationCount)/log1p(maxCit))` |
| 年份色带 | 单色系顺序色阶（浅青灰 `#d8e6e2` → 深墨绿 `#0f4c46`），**不要彩虹色** |
| 标签 | `Author 姓氏, 年份`；10px；`#3c4a48`；`text-anchor: middle`；位于圆上方 14px |
| 种子节点 | 更深的填充 + 光晕（`feDropShadow` 或外圈浅色环）+ 稍大半径 |
| 图例 | 右下角，水平渐变条 + 两端年份数字 |
| 留白 | 图外围 ≥ 40px；节点间距靠 `forceCollide` 保证 |

### 7.3 颜色映射

```ts
// colorScale.ts
import { scaleLinear } from "d3-scale";
import { interpolateRgb } from "d3-interpolate";

export const makeYearColor = (yearMin: number, yearMax: number) => {
  const s = scaleLinear<string>()
    .domain([yearMin, yearMax])
    .range(["#d8e6e2", "#0f4c46"])
    .clamp(true)
    .interpolate(interpolateRgb);
  return (year: number | null) => (year == null ? "#b9c4c1" : s(year));
};
```

### 7.4 标签避让

朴素做法（够用）：按 y 升序排标签，若与已放置标签矩形相交，则上移 12px 再测，最多试 3 次，仍冲突则不画。
进阶：四叉树/`d3-force` 加 `forceCollide` 到标签代理点。

**缩放阈值**：`k < 0.6` 时隐藏非种子标签（否则 300 个标签糊满屏）。

### 7.5 交互

```ts
// useZoomPan.ts（每次 wheel/drag 只改 transform，不重建 DOM）
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const k2 = clamp(0.2, 8, k * factor);
  // 以鼠标位置为中心缩放
  tx = e.offsetX - (e.offsetX - tx) * (k2 / k);
  ty = e.offsetY - (e.offsetY - ty) * (k2 / k);
  k = k2;
  panplane.setAttribute("transform", `translate(${tx},${ty}) scale(${k})`);
  if (k < 0.6) labels.classList.add("hidden"); else labels.classList.remove("hidden");
}
```

- hover：高亮该节点 + 其邻接边（其余降 `opacity .15`）。
- click：选中 → 右侧详情面板；同时在图上加选中环。
- dblclick / "居中" 按钮：把该节点平移到画布中心，`k` 恢复到 1。

### 7.6 左侧列表与右侧详情

同一份 `GraphDoc` 派生，不需要额外请求：

- 左侧：`nodes.filter(n => n.paperId !== startId).sort(byWeightDesc)` → 卡片（标题、作者、年份徽标）。
- 右侧：选中节点 → 标题、作者、`year, venue`、`citationCount Citations`、`Open in`（S2/DOI/Google Scholar 由 `externalIds` 拼 URL）、摘要。

---

## 8. 导出图片

两条路线，建议都实现：前端导出给用户离线保存，无头浏览器导出给服务端批量/分享卡。

### 8.1 路线 A：浏览器内 SVG → PNG

```ts
// exportPng.ts
export async function exportGraphPng(svg: SVGSVGElement, opts: {
  width: number; height: number; scale?: number; background?: string;
}) {
  const scale = opts.scale ?? 2;              // 2x 保证清晰度
  const clone = svg.cloneNode(true) as SVGSVGElement;

  // 1) 去掉交互态样式（hover/选中环），保证导出干净
  clone.querySelectorAll(".is-hover,.is-selected-ring").forEach(n => n.remove());

  // 2) 显式设置尺寸与背景（SVG 自身没有背景色）
  clone.setAttribute("width", String(opts.width));
  clone.setAttribute("height", String(opts.height));
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%");
  bg.setAttribute("fill", opts.background ?? "#ffffff");
  clone.insertBefore(bg, clone.firstChild);

  // 3) 内联字体：把 text 的 font-family 换成系统栈，或把 woff2 以 data: 塞进 <style>
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `text{font-family:system-ui,"Segoe UI",Roboto,sans-serif}`;
  clone.insertBefore(style, clone.firstChild);

  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));

  const img = new Image();
  img.decoding = "sync";
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(opts.width * scale);
  canvas.height = Math.round(opts.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.drawImage(img, 0, 0, opts.width, opts.height);
  URL.revokeObjectURL(url);

  return new Promise<Blob>((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}
```

必踩的坑：

| 坑 | 现象 | 对策 |
|---|---|---|
| `foreignObject` | Chrome 能渲染，导出为空白 | 全部用原生 SVG 元素绘制文字 |
| 外部字体 | 导出后变宋体/变成方块 | 内联 `@font-face`(base64) 或直接用系统字体栈 |
| 跨域图片/字体 | `canvas` 被污染，`toBlob` 抛 `SecurityError` | 资源开启 CORS，或全部转 `data:` |
| `<use href="#...">` | 部分浏览器导出丢图形 | 导出前展开 `use`（内联被引用节点） |
| 缺 `xmlns` | Safari 不渲染 | 序列化前确保有 `xmlns="http://www.w3.org/2000/svg"` |
| 高 DPI 模糊 | 文字与圆边发虚 | `scale = devicePixelRatio || 2`，并 `ctx.setTransform` |

### 8.2 路线 B：服务端截图（分享卡、批量导出）

给你自己的页面加一个"纯渲染模式"路由 `/embed/graph/:paperId?format=png`（无 header、固定画布尺寸），然后用 Playwright 截图：

```ts
// renderPng.ts
import { chromium } from "playwright-core";

export async function renderGraphPng(paperId: string) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
  });
  await page.goto(`${process.env.BASE_URL}/embed/graph/${paperId}?format=png`,
                 { waitUntil: "networkidle" });

  // ★ 关键：等布局真正结束，而不是等 networkidle
  await page.waitForSelector('#maingraph[data-layout="done"]', { timeout: 20000 });
  await page.waitForTimeout(300);                     // 让最后几帧渲染完成

  const el = await page.$("#maingraph")!;
  const png = await el.screenshot({ type: "png", omitBackground: false });
  await browser.close();
  return png;
}
```

前端需要在布局结束后打标记：

```ts
sim.on("end", () => {
  redraw();
  document.getElementById("maingraph")!.dataset.layout = "done";
});
```

**导出确定性**：布局随机种子固定 + 服务端坐标优先 → 同一篇论文任何时候导出都是同一张图。这一点如果不做，用户会反复导出"看起来不一样"的图。

---

## 9. 服务端任务与缓存

```
POST /api/graph/:paperId          → { graphId, status: "QUEUED" }
GET  /api/graph/:paperId          → { graphId, status, progress }
GET  /api/graph/:graphId/doc      → GraphDoc(JSON) 或二进制
POST /api/graph/:paperId/rebuild  → 触发重建（引文数据更新后）
```

状态机：

```
NOT_RUN → ADDED_TO_QUEUE → IN_QUEUE → IN_PROGRESS(progress%) → OK
                                              ↘ ERROR / OVERLOADED / NOT_IN_API
```

- 前端轮询间隔 **2s**（实测参考实现就是这个值），成功即停。
- 同一用户同一时刻只允许 1~2 个构图任务（浏览器端排队），否则高被引论文会打爆后端。
- 缓存 key：`paperId + layoutVersion + paramsVersion`；引文数据变化 → 新 `graphId`，旧版本保留（支持"有新版本可用"提示）。
- 二进制传输（可选，但值得做）：deflate 压缩的 JSON，配一个定长头，比裸 JSON 小 5~10 倍：

```
magic(4) | status(uint32) | payloadLen(uint32) | payload | uuidLen(uint32) | uuid
status=1 → payload = deflate(JSON)；status=3 → payload = uint32 进度
```

---

## 10. 目录结构与技术选型

```
packages/
  graph-core/                 # 纯函数，无框架依赖，可单测
    src/ids.ts                # ID 归一化
    src/sources/{s2,openalex,crossref}.ts
    src/expand.ts             # 邻居扩展 + common_* 计算
    src/similarity.ts
    src/prune.ts
    src/layout.ts             # d3-force 服务端预算
    src/serialize.ts          # GraphDoc ↔ 二进制
    src/types.ts
  api/                        # 队列、缓存、REST
  web/
    src/graph/
      GraphCanvas.tsx|vue     # SVG 结构 + 渲染
      useForceLayout.ts       # 前端微调
      useZoomPan.ts
      colorScale.ts
      labelLayout.ts
      exportPng.ts
      YearLegend.tsx|vue
    src/panels/ ListPanel, DetailPanel
  render/                     # Playwright 截图服务
```

选型建议：

| 关注点 | 建议 | 说明 |
|---|---|---|
| 力导向 | `d3-force` | 体积小、可控、可固定种子；比 `cytoscape`/`sigma` 更好控视觉 |
| 渲染 | 原生 SVG（≤800 节点） | 截图/导出最省事；超过再用 canvas |
| 缩放平移 | 手写 transform | 引入 `d3-zoom` 也可以，但要处理与导出复用 |
| 色阶 | `d3-scale` + `d3-interpolate` | 单色系顺序色阶 |
| 截图 | `playwright-core` + 本机 Chrome | 不要捆绑浏览器，用系统已装的 |

---

## 11. 可调参数表

| 参数 | 建议默认 | 影响 |
|---|---|---|
| `numNeighbors` (k) | 8 | 每篇保留的邻居数；越大越密越乱 |
| `maxLoad` | 200 | 节点上限；SVG 舒适区 |
| 边权阈值 | 0.08 | 过滤弱关系 |
| `springIterations` | 300 | 布局质量 vs 计算时间（线性） |
| 边 `strength` 系数 | 0.1 + 0.5w | 强关系更近 |
| 斥力 | -260 | 越大越散 |
| 碰撞半径 | r + 6 | 决定节点不重叠的间距 |
| 标签显示阈值 | k ≥ 0.6 | 缩小时隐藏标签 |
| 半径范围 | 5~22 | 防止高被引节点吞画布 |
| 导出 DPR | 2 | 分享卡清晰度 |
| 轮询间隔 | 2000ms | 秒级体验 vs 后端压力 |

---

## 12. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| M1 数据 | 输入 paperId → 输出 `GraphDoc`(JSON)，含 nodes/edges/pos | 单测：给定 fixture 引文数据，输出节点数、边数、截断标记正确 |
| M2 静态图 | 用 `GraphDoc` 渲染出无交互 SVG | 截图肉眼对齐视觉规格（配色/半径/标签） |
| M3 布局 | 服务端预算 + 归一化，图不重叠、不负空间 | 同一 graphId 两次渲染像素级一致（除抗锯齿） |
| M4 交互 | 缩放/平移/hover/选中/详情面板/左列表 | 300 节点仍 60fps 拖拽 |
| M5 导出 | 浏览器 PNG 导出 + 服务端 Playwright 截图 | 2x PNG，字体正确，无空白区域 |
| M6 工程化 | 队列/状态机/缓存/版本/重建 | 高被引论文不阻塞其他请求；重复请求命中缓存 |

---

## 13. 合规与数据许可

- 引文数据来自第三方 API（Semantic Scholar / OpenAlex / Crossref）：**遵守其速率限制与署名要求**，缓存元数据以减少请求。
- 不要复制他人产品的布局参数、配色与视觉资产；本文的规格是通用图形设计选择。
- 导出图片应标注数据来源与"数据截至日期"（`meta.dataAsOf`）。
- 用户查询的论文 ID 与由此产生的图谱属于用户数据，按最小必要保留。

---

## 14. 一句话总结

> 这张图 = **引文图数据（1 个种子 + 邻居 + 权重）** × **确定性布局（服务端力导向 + 归一化坐标）** × **分层 SVG 渲染（边/点/标签 + 年份色阶）** × **导出管线（SVG → canvas → PNG，或 Playwright 截图）**。
>
> 论文本身只提供了种子；真正让图"长得像那样"的是：**二阶共被引/共引数据、每对节点的权重、预算好的坐标、以及一套克制的视觉规格**。
