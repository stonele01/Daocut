# Daocut 0.2.29 交接

更新日期：2026-11-11。本文件说明当前代码与验收边界，替代旧文档中的“程序枚举、原速、30～50 秒仅供参考”等阶段性描述。仓库核心目录现为 `packages/daocut`。

## 目前做到哪里

0.2.29 已在原开发环境完成本机桌面更新。完整提示词、AI 拼结构、逐段预览、独立草稿与既有剪映草稿导出已接通。源码和模拟验收已完成；真实模型的选材、取舍、上下文和接缝质量尚未完成验收。

这次修复的具体问题：0.2.28 虽包含新提示词，但已有完整旧方案时，普通“拼结构”只会读取旧结果，没有明确使用新规则的入口。0.2.29 增加“按新版规则拼一版”，保留旧方案及个人修改。

## 用户操作流程与当前规则

1. 整场直播先拆商品，用户查看、修正名称和讲解范围。已是单商品素材时，可明确把整段设为一次讲解。返场分别选择，不自动合并。
2. “分析”只处理选中的一次讲解。已有完整分析优先复用；失败优先恢复返回或补存，结果或费用不明不自动重发。分析完成后发现错误，也不能擅自重跑。
3. “拼结构”是独立的 AI 请求，使用该次讲解已保存的话术、完整转写和适用核查证据。普通点击先读取结果；旧方案可主动选择“按新版规则拼一版”。同事已有新版则直接复用，没有时才显示新请求确认。取消不发送，也不切掉旧列表。
4. AI 返回母候选编号、完整连续子段首尾 cue 和子段标签。程序恢复原话和原片位置，校验范围与结构，不替 AI 编造台词或机械枚举。
5. 新方案使用 **1.3 倍速，成片 30～40 秒**，对应所选源区间合计 39～52 秒，区间内停顿计入。正文排列不变；旧 v1 方案和旧个人草稿不自动改速。
6. 每条必须有开头、1～2 个完整卖点单元、末尾购买逼单。除逼单外，完整的故事、痛点、卖点、展示、福利或背书都可以作钩子；福利机制包含价格对比。痛点、福利和背书按素材取舍，不能为了齐标签硬凑。
7. 右侧显示方案与版本；点击方案或结构点在播放器预览，不改下方时间轴。“编辑副本”才进入自己的独立草稿。每条裁剪、排序、字幕与设置分别自动保存，切换时等待保存完成。
8. 勾选或全选后，使用原右上角导出入口，仍导出剪映草稿。优先使用对应个人草稿，提交时固定各自版本；切换或继续编辑不会让已排队项目导错。没有新增批量 MP4 功能。

## 旧分析为什么通常能复用

旧候选长，不等于需要重新分析。新版拼结构可依据已有原始转写，从母段内细选完整连续小段，同时保留必要上下文。前提是转写完整、cue 编号与时间真实、商品归属可核对。

只有摘要、转写缺失、编号不匹配，或者一句 cue 本身过长时，不能猜词级切点，应提示核对。缺少所需信息不自动补发模型请求。

三份完整审阅提示词在 `packages/daocut/studio/server/prompts/`；`approved-prompts.mjs` 负责加载。`docs/prompts-review-20261111/` 是逐字比对的审阅基准，修改提示词必须连同判断要求与测试审查，不能随意缩短。旧提示词仍保留，用于旧请求身份匹配和回执恢复。

## 关键代码

| 位置 | 作用 |
| --- | --- |
| `studio/server/product-discovery*.mjs` | 整场拆商品及各次讲解 |
| `studio/server/text-structure.mjs`、`live-analysis.mjs`、`product-workflow.mjs` | 单次讲解分析、确认、缓存与回执恢复 |
| `studio/server/product-media-review.mjs`、`product-visual-review.mjs` | 复用本地音画工具及现有看图能力，保存核查证据 |
| `studio/server/ai-structure.mjs` | 第三段 AI 提示词、请求与版本协议 |
| `studio/server/ai-structure-ranges.mjs` | v2 子段、时长、结构、已记录依赖和条件校验 |
| `studio/server/ai-structure-plans.mjs` | 版本选择、明确请求确认、共享复用、恢复与补存 |
| `studio/ui/src/components/StructureWorkspace.tsx`、`StructurePlanPreview.tsx` | 新规则入口、方案版本、预览和草稿切换 |
| `studio/server/structure-drafts.mjs`、`structure-workspace.mjs` | 独立草稿、保存和重开 |
| `studio/server/structure-export-snapshot.mjs`、`structure-batch-exports.mjs` | 按所选 taskKey 固定版本并复用剪映导出 |

表内路径均相对 `packages/daocut/`。原 `structure-composition.mjs` 的规则与旧版逻辑仍供兼容和校验；正常“拼结构”入口已经使用 AI 服务，不能据旧模块存在就称当前仍是程序枚举。

## 共享与恢复边界

- 配置并关联共享底稿后，同输入、同规则的公共结果协调复用；本机私人补充不能偷偷改变公共输入。
- 新旧规则分别保存，`rulesVersion` 与 `taskKey` 必须属于当前输入；新旧版本均可预览、编辑及导出。
- 同一次讲解正在执行请求时，不会因切版本再启动另一请求。旧失败、费用不明或待补存不能借升级自动重发；已有完整新版可只读复用。
- 本轮没有新增公共结果修正权限或升级提醒弹窗。公共修正政策仍需业务决定；保留原记录和私人草稿是硬约束。
- 模型 `complete=true` 仅表示它完成本轮梳理，**不代表数学穷尽**。`allValidCombinationsEnumerated` 保持 false。不同有效方案保留，相同播放内容去重；后续补充另行确认。
- 程序能校验真实边界、原话、重叠、已记录依赖及条件冲突，不能证明所有指代和购买逻辑都通顺。静帧也不能证明连续动作或音频含义。

## 验证与接手检查

原开发环境使用隔离工程、模拟模型和合成音画完成：服务/集成 81 项、浏览器 11 项、UI 逻辑 17 项、类型检查；实际 0.2.29 包内 13 套共 166 项通过，包含合成音画的 1.3 倍剪映导出。包内完整提示词和 UI 与已验收构建一致。该记录不等于真实直播质量或新机器安装验收。

本次提交基于远端重建后的历史与 `packages/daocut` 目录，未重新引入旧现场记录。适配后另跑服务测试 175/175、UI 逻辑 20/20 和类型检查通过；打包清单检查确认包含三份完整提示词、排除两个私人辅助脚本。没有重新安装软件或调用真实模型。

先按 [开发说明](DEVELOPMENT.md) 设置隔离目录和依赖。从核心包目录运行针对性检查：

```powershell
cd packages/daocut
node --test --test-concurrency=1 studio/server/approved-prompts.test.mjs studio/server/ai-structure-ranges.test.mjs studio/server/ai-structure-plans.test.mjs studio/server/structure-version-workspace-exports.test.mjs studio/server/structure-batch-exports.test.mjs studio/server/structure-workspace-routes.test.mjs
npm run typecheck
```

浏览器测试使用 `DAOCUT_STRUCTURE_UI` 指向隔离 UI 构建，可用 `DAOCUT_TEST_CHROME` 指定 Chrome。相关用例为 `structure-rules-entry-browser.test.mjs`、`structure-preview-focus-browser.test.mjs`、`structure-workspace-browser.test.mjs`。测试临时目录应保持简短，避免 Windows 路径长度干扰。

## 下一步

先选择一段已有完整转写的真实商品讲解，在独立验收工程中明确确认新版拼结构，检查取舍、上下文、片段切口、1.3 倍音画、草稿重开和剪映导出。之后再验证真实双机共享、长直播与大量方案负载。

真实模型请求、真实 NAS 操作、既有服务重启及后续安装更新，均按具体动作重新确认。整理交接和推送 Git 不扩大这些授权。源码提交不含原片、生产转写、个人工程、原始模型回执、本机访问密钥、现场部署记录或安装包；不要重新引入远端已清理的历史材料。
