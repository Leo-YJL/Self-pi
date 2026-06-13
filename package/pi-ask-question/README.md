# pi-ask-question

<p align="right">
  <a href="#中文">中文</a> | <a href="#english">English</a>
</p>

<a id="中文"></a>

<details open>
<summary><strong>中文说明</strong></summary>

## 项目简介

`pi-ask-question` 是一个 Pi package，提供 `ask_user_question` 工具，用于在需求不明确时向用户提出结构化问题。

它兼容普通选择题，同时支持面向 grill-me / PRD 澄清流程的 **Decision Card 决策卡**：背景、歧义、推荐答案、理由、选项后果和持久化目标都可以结构化传入。

## 功能

- 注册 Pi 工具：`ask_user_question`
- 一次最多 4 个问题
- 每个问题 2-4 个选项
- 单选 + 自定义答案
- 多选
- `Chat about this` 回到自由对话
- option `preview`
- option `notes`
- Decision Card 字段：
  - `decisionId`
  - `severity`
  - `context`
  - `ambiguity`
  - `recommendation`
  - `why`
  - `persistTo`
- Option 扩展字段：
  - `value`
  - `recommended`
  - `consequence`
- 快捷键：
  - `a` 接受推荐选项
  - `d` 展开/收起决策详情
  - `n` 给选项添加备注

## Pi package 资源

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## 安装

发布到 npm 后：

```bash
npm install @leo-yjl/pi-ask-question
```

或通过 Pi package 安装：

```bash
pi install npm:@leo-yjl/pi-ask-question@0.1.0
```

本地开发时可以用路径加载：

```json
{
  "packages": ["<repo>/package/pi-ask-question"]
}
```

## 普通问题示例

```ts
ask_user_question({
  questions: [
    {
      question: "Which implementation approach should I use?",
      header: "Approach",
      options: [
        {
          label: "Minimal",
          description: "Smallest safe patch; lower risk but less cleanup."
        },
        {
          label: "Refactor",
          description: "Cleaner design; more changes and test coverage needed."
        }
      ]
    }
  ]
})
```

## Decision Card 示例

```ts
ask_user_question({
  questions: [
    {
      decisionId: "image-pool.runtime-hard-whitelist",
      severity: "blocking",
      persistTo: "prd",
      header: "Runtime",
      question: "ImagePoolId > 0 时，运行时是否只从关卡图片池取图？",
      context: "策划可以手动删除图片后刷新图片池。",
      ambiguity: "如果不明确，运行时可能在候选不足时回退默认池，导致被删图片仍然出现。",
      recommendation: "采用硬白名单：只从 PuzzleLevelImagePool.ImageIds 取图，不回退默认池。",
      why: "这样刷新/删图语义最稳定，运行时不会违背策划筛选结果。",
      options: [
        {
          label: "硬白名单",
          value: "hard_whitelist",
          recommended: true,
          description: "只从关卡图片池取图，不回退默认池。",
          consequence: "候选不足时需要编辑器校验或运行时报错。"
        },
        {
          label: "默认池兜底",
          value: "fallback_default_pool",
          description: "关卡池不足时回退默认池。",
          consequence: "可能随机出策划已经删除的图片。"
        }
      ]
    }
  ]
})
```

## 返回 details

```ts
{
  answers: [
    {
      questionIndex: 0,
      question: "...",
      kind: "option" | "custom" | "chat" | "multi",
      answer: "..." | null,
      selected?: ["..."],
      notes?: "...",
      decisionId?: "image-pool.runtime-hard-whitelist",
      severity?: "blocking",
      answerValue?: "hard_whitelist",
      selectedValues?: ["..."],
      acceptedRecommended?: true,
      recommendedValue?: "hard_whitelist",
      persistTo?: "prd",
      consequence?: "..."
    }
  ],
  cancelled: false
}
```

## 与 workflow-grill 的推荐配合

- 每个阻塞性歧义使用一个 Decision Card。
- 每组最多 3-4 个相关问题。
- 推荐答案必须说明 `why` 和后果。
- 用户回答后，agent 应将 `persistTo=prd` 的结果写入任务 PRD 的 Decisions 区域。
- 只有长期项目事实才写入 `.workflow/spec/**`。

## 开源协议

本项目采用 [MIT License](LICENSE) 开源。

</details>

<a id="english"></a>

<details>
<summary><strong>English</strong></summary>

## Overview

`pi-ask-question` is a Pi package that provides the `ask_user_question` tool for structured user clarification.

It is backward compatible with simple option questions and also supports **Decision Cards** for grill-me / PRD clarification workflows: context, ambiguity, recommendation, rationale, option consequences and persistence targets can all be passed structurally.

## Features

- Registers Pi tool: `ask_user_question`
- Up to 4 questions per call
- 2-4 options per question
- Single-select with custom answer fallback
- Multi-select
- `Chat about this` escape hatch
- option `preview`
- option `notes`
- Decision Card fields:
  - `decisionId`
  - `severity`
  - `context`
  - `ambiguity`
  - `recommendation`
  - `why`
  - `persistTo`
- Option extension fields:
  - `value`
  - `recommended`
  - `consequence`
- Shortcuts:
  - `a` accept recommended option
  - `d` expand/collapse decision details
  - `n` add option note

## Pi package resources

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Installation

After publishing to npm:

```bash
npm install @leo-yjl/pi-ask-question
```

Or install as a Pi package:

```bash
pi install npm:@leo-yjl/pi-ask-question@0.1.0
```

For local development, load it by path:

```json
{
  "packages": ["<repo>/package/pi-ask-question"]
}
```

## Basic question example

```ts
ask_user_question({
  questions: [
    {
      question: "Which implementation approach should I use?",
      header: "Approach",
      options: [
        {
          label: "Minimal",
          description: "Smallest safe patch; lower risk but less cleanup."
        },
        {
          label: "Refactor",
          description: "Cleaner design; more changes and test coverage needed."
        }
      ]
    }
  ]
})
```

## Decision Card example

```ts
ask_user_question({
  questions: [
    {
      decisionId: "image-pool.runtime-hard-whitelist",
      severity: "blocking",
      persistTo: "prd",
      header: "Runtime",
      question: "When ImagePoolId > 0, should runtime draw only from the level image pool?",
      context: "Designers can manually delete images and refresh the image pool.",
      ambiguity: "Without a clear rule, runtime may fall back to the default pool and show deleted images.",
      recommendation: "Use a hard whitelist: draw only from PuzzleLevelImagePool.ImageIds and do not fall back.",
      why: "This makes refresh/delete semantics stable and respects designer filtering.",
      options: [
        {
          label: "Hard whitelist",
          value: "hard_whitelist",
          recommended: true,
          description: "Draw only from the level image pool; no default fallback.",
          consequence: "Insufficient candidates must be caught by editor validation or runtime error."
        },
        {
          label: "Fallback default",
          value: "fallback_default_pool",
          description: "Fallback to the default pool when the level pool is insufficient.",
          consequence: "Images removed by designers may still appear."
        }
      ]
    }
  ]
})
```

## Result details

```ts
{
  answers: [
    {
      questionIndex: 0,
      question: "...",
      kind: "option" | "custom" | "chat" | "multi",
      answer: "..." | null,
      selected?: ["..."],
      notes?: "...",
      decisionId?: "image-pool.runtime-hard-whitelist",
      severity?: "blocking",
      answerValue?: "hard_whitelist",
      selectedValues?: ["..."],
      acceptedRecommended?: true,
      recommendedValue?: "hard_whitelist",
      persistTo?: "prd",
      consequence?: "..."
    }
  ],
  cancelled: false
}
```

## Recommended workflow-grill usage

- Use one Decision Card per blocking ambiguity.
- Ask at most 3-4 related questions per group.
- Recommended answers must include `why` and consequences.
- After the user answers, the agent should write `persistTo=prd` results to the task PRD Decisions section.
- Only durable project facts should be written to `.workflow/spec/**`.

## License

This project is released under the [MIT License](LICENSE).

</details>
