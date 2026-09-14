// 派生记忆与 Artifact 材料清单的团队界面开关。
// 这两类内容使用频率低，暂时在团队共享界面整体隐藏（统计卡、审核标签页、
// 提交入口、已批准展示区、内容类型下拉选项等）；需要恢复时改回 true 即可。
// 只影响 Web 展示层：后端 /api/team/derived/*、/api/team/artifacts* 接口、
// agent 工具（propose_derived / propose_artifact）与团队数据均不受影响。
export const showDerivedAndArtifactFeatures = false;
