# codex-meter

`codex-meter` 是一个本地 Codex 日志诊断工具。

它不是单纯把日志导出来，而是帮你回答这些问题：

- 这次为什么慢？
- 这次为什么 Token 用得高？
- AI 到底做了什么？
- 时间花在了哪里？
- Token 主要消耗在了哪里？
- 是需求描述不清、上下文过大、工具调用太多，还是本地环境太慢？

`codex-meter` 会读取你本机已有的 Codex 日志，整理成一个可直接打开的静态 HTML 站点，方便你按“每次提问”去复盘整个过程。

## 适合谁

- 经常使用 Codex，希望知道为什么一次任务特别慢
- 想分析为什么某次提问消耗了很多 Token
- 想看清楚 AI 在一次问答里到底做了哪些事
- 想优化自己的提问方式、项目结构或本地工具链

## 核心能力

- 扫描本机 Codex 历史日志
- 以“单次提问 / 单次问答”为单位生成诊断
- 展示 AI 做了什么、每一步花了多久
- 展示模型响应耗时和 Token 去向
- 分析上下文膨胀、Prompt 问题、工具耗时、修复循环
- 生成纯静态中文站点，无需服务端
- 在问答详情页按需生成 AI 复盘建议，直接给出更省时省 Token 的重写提示词

## 数据来源

`codex-meter` 只读取本机数据，不请求云端日志接口。

当前主要使用这些本地文件：

- `~/.codex/archived_sessions/*.jsonl`
- `~/.codex/session_index.jsonl`
- `~/.codex/logs_2.sqlite`

## 安装与运行

如果你只是本地直接运行当前项目：

```bash
node ./bin/codex-meter.js init
node ./bin/codex-meter.js update
node ./bin/codex-meter.js open
```

如果你之后发布到 npm，也可以支持：

```bash
npx @noahliao/codex-meter init
npx @noahliao/codex-meter update
npx @noahliao/codex-meter open
```

## 命令说明

### `init`

首次初始化。

它会：

- 创建 `.codex/codex-meter/`
- 首次全量扫描本机 Codex 日志
- 建立缓存
- 生成第一版静态站点

```bash
node ./bin/codex-meter.js init
```

### `update`

增量更新。

它会：

- 扫描新增或变更的本地 Codex 日志
- 更新缓存
- 重新计算诊断结果
- 重建 HTML 页面

```bash
node ./bin/codex-meter.js update
```

### `open`

启动本地网页服务并打开站点首页：

```bash
node ./bin/codex-meter.js open
```

静态产物仍然生成在这个相对路径：

```text
.codex/codex-meter/site/index.html
```

但为了让详情页里的“生成 AI 复盘建议”按钮能真正工作，`open` 会启动一个本地网页服务，再打开浏览器访问本地地址。
现在默认会启动后台本地服务，所以终端可以直接结束；如果 AI 复盘按钮异常，可以查看：

```text
.codex/codex-meter/logs/server.log
```

## 生成结果

运行后会在项目里生成：

```text
.codex/
  codex-meter/
    config.json
    cache/
    site/
      index.html
      conversations/
      turns/
```

其中：

- `cache/` 是本地缓存，用于加速后续更新
- `site/` 是最终生成的静态站点

## 站点里能看到什么

### 首页

- 历史对话列表
- 每个对话的更新时间
- 累计耗时
- 累计 Token
- 对话级主要问题摘要

### 对话页

- 这个对话里有多少次问答
- 每次问答的耗时
- 每次问答的 Token
- 每次问答的主问题摘要

### 单次问答详情页

- 本次提问
- AI 最终答复（如果本地日志里存在）
- AI 做了什么
- 每一步发生时间
- 每一步耗时
- 模型响应明细
- Token 去向
- 工具统计
- 上下文膨胀证据
- 原始时间线
- AI 复盘建议：告诉你这次提示词为什么放大了时间 / Token 成本，以及应该怎么重写

## 目前的判断逻辑

当前会重点分析这些方向：

- 需求描述是否过短
- 是否指定了目标文件 / 页面 / 组件
- 是否限制了修改范围
- 是否给出了验收标准
- 是否发生了大范围项目搜索
- 是否读取了过多文件
- 是否重复读取同一批文件
- 是否有重型本地命令拖慢总耗时
- 是否出现修复循环

## 重要说明

### 1. 这是本地诊断工具

`codex-meter` 的目标是解释“为什么慢、为什么贵、为什么效率低”，不是做云端监控平台。

### 2. 某些字段取决于本机日志是否存在

有些历史问答，本地日志并不会完整保存最终答复正文。

所以某些页面里可能会看到：

- 只记录到执行过程
- 没记录到完整最终答复

这不是 `codex-meter` 伪造数据，而是会尽量忠实展示本地能恢复出来的内容。

### 3. AI 复盘是按需生成的

问答详情页里的 AI 复盘建议不是 `update` 时批量生成的。

只有你点按钮时，才会调用本地可用的 Codex / OpenAI 能力去生成建议，并把结果缓存到本地。

### 4. 工具步骤不一定能精确拆分 Token

当前本机日志通常可以更精确地恢复：

- 模型请求耗时
- 模型响应级 Token 统计
- 工具执行耗时

但“某一次工具调用单独消耗了多少 Token”通常无法从本地日志精确恢复，所以页面会把它和模型响应级 Token 区分展示。

## 当前定位

一句话：

> Analyze why your Codex task is slow, expensive, or inefficient.

## 开发状态

当前是 v1 方向，重点先放在：

- 本地日志扫描
- 诊断分析
- 静态 HTML 输出

暂不包含：

- GUI 应用
- 云同步
- 多用户
- 在线仪表盘

## License

MIT
