# pi-ask-question Implementation Plan

目标：把现有 `ask_user_question` 从“普通结构化选择题”升级为可复用的 Pi package，并支持 grill-me / workflow-grill 所需的 **Decision Card 决策确认** 交互。

## 背景

从历史 grill-me 对话中抽象出的高频模式：

1. Assistant 先给出背景和歧义点；
2. Assistant 给出推荐答案和理由；
3. 用户确认、修正或要求讨论；
4. 决策被稳定记录到 PRD / spec / 后续实现计划中。

这不是普通问答，而是 **需求澄清决策卡**。

## 设计原则

- 保留原 `ask_user_question` 工具名，降低迁移成本。
- 兼容旧 schema：`question/header/options/multiSelect` 继续可用。
- 新增字段全部可选。
- 不在工具内直接写文件；工具只返回结构化答案，是否写 PRD/spec 由 workflow skill 或 agent 决定。
- UI 优先服务“接受推荐 / 修改推荐 / 继续讨论”的快速决策流程。
- 每轮最多 4 个问题，避免一次性压给用户过多决策。

## Phase 0：Package Skeleton

- [x] 在 monorepo 中新增 `package/pi-ask-question`。
- [x] 配置 package manifest：`@leo-yjl/pi-ask-question`。
- [x] 使用 Pi package manifest：`pi.extensions = ["./src/index.ts"]`。
- [x] 复制 MIT LICENSE。
- [x] 创建本计划文档。

## Phase 1：Baseline Migration

- [x] 迁移原 `ask_user_question` 的核心能力：
  - 单选；
  - 多选；
  - 自定义答案；
  - Chat about this；
  - preview；
  - option notes；
  - renderCall / renderResult。
- [x] 拆分为更清晰的 src 结构：
  - `constants.ts`
  - `schema.ts`
  - `types.ts`
  - `validation.ts`
  - `result.ts`
  - `ui.ts`
  - `index.ts`

## Phase 2：Decision Card Schema

- [x] Question 新增可选字段：
  - `decisionId`
  - `severity`
  - `context`
  - `ambiguity`
  - `recommendation`
  - `why`
  - `persistTo`
- [x] Option 新增可选字段：
  - `value`
  - `recommended`
  - `consequence`
- [x] 返回答案新增：
  - `decisionId`
  - `severity`
  - `answerValue`
  - `selectedValues`
  - `acceptedRecommended`
  - `recommendedValue`
  - `persistTo`
  - `consequence`

## Phase 3：Decision UI

- [x] UI 展示 decision id / severity / persist target。
- [x] UI 展示 Context / Ambiguity / Recommendation / Why。
- [x] 选项显示 Recommended 标记。
- [x] 支持 `a` 快捷键接受推荐选项。
- [x] 支持 `d` 展开/收起决策详情。
- [ ] 支持一组问题的 “accept all recommended”。

## Phase 4：Workflow Grill Integration

- [x] 更新 `package/pi-coding-workflow/skills/workflow-grill/SKILL.md`：
  - 使用 Decision Card 格式生成阻塞问题；
  - 每组最多 3-4 个相关问题；
  - 推荐答案必须说明理由和代价；
  - 用户回答后写入任务 PRD 的 Decisions / Open Questions；
  - 长期项目事实才写入 `.workflow/spec/**`。
- [ ] 如果需要，更新 workflow README 的推荐 package 列表。

## Phase 5：Docs and Publish Readiness

- [x] 新增双语 README。
- [x] 增加 npm package 元数据：repository、bugs、homepage、files、engines、publishConfig。
- [x] 执行 `npm pack --dry-run`。
- [x] 执行 `npm publish --dry-run`。
- [x] 发布前确认使用 `@leo-yjl/pi-ask-question` npm scope。

## Phase 6：Validation in Pi

- [ ] 用本地 package 路径加载：
  ```json
  { "packages": ["D:/YJL_AI/PI_Package/pipackage/package/pi-ask-question"] }
  ```
- [ ] 验证普通旧 schema 调用。
- [ ] 验证 Decision Card 调用。
- [ ] 验证快捷键：Enter / Space / n / a / d / Esc。
- [ ] 验证返回 details 是否足够让 workflow-grill 写 PRD 决策日志。

## 后续可选

- [ ] 增加 `/ask-question-demo` 命令展示 Decision Card 示例。
- [ ] 增加 JSON schema snapshot 测试。
- [ ] 增加批量决策 summary artifact。
- [ ] 与 `pi-coding-workflow` 的 PRD kernel 决策区做更强联动。
