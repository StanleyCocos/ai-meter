import path from "node:path";

import { escapeHtml, formatDateTime, formatDuration, formatNumber, percent, writeText } from "./utils.js";

const TOOL_CATEGORY_LABELS = {
  Read: "读取",
  Edit: "修改",
  Bash: "命令",
  Search: "搜索",
  Grep: "文本搜索",
  Other: "其他",
};

const FIX_LOOP_LEVEL_LABELS = {
  High: "高",
  Medium: "中",
  Low: "低",
};

const TIMELINE_TYPE_LABELS = {
  turn_context: "回合上下文",
  task_started: "任务开始",
  task_complete: "任务完成",
  turn_aborted: "回合中断",
  user_message: "用户消息",
  assistant_message: "助手消息",
  token_count: "Token 统计",
  reasoning: "推理",
  tool_call: "工具调用",
  tool_output: "工具输出",
  patch_apply_end: "补丁应用结果",
};

function toolCategoryLabel(category) {
  return TOOL_CATEGORY_LABELS[category] || category || "其他";
}

function fixLoopLevelLabel(level) {
  return FIX_LOOP_LEVEL_LABELS[level] || level || "未知";
}

function timelineTypeLabel(type) {
  return TIMELINE_TYPE_LABELS[type] || type || "事件";
}

function pageChrome(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f6f4ee;
      --panel: #fffdf7;
      --ink: #182020;
      --muted: #6d766e;
      --accent: #155eef;
      --accent-soft: #d9e7ff;
      --warn: #a15c07;
      --danger: #a12626;
      --success: #1b6c3e;
      --border: #d9d2c0;
      --shadow: 0 18px 60px rgba(30, 20, 10, 0.08);
      --mono: ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
      --sans: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(21, 94, 239, 0.08), transparent 28%),
        radial-gradient(circle at right 20%, rgba(161, 92, 7, 0.08), transparent 22%),
        var(--bg);
      color: var(--ink);
      font-family: var(--sans);
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .page { max-width: 1240px; margin: 0 auto; padding: 32px 20px 48px; }
    .hero {
      background: linear-gradient(135deg, rgba(255,255,255,0.92), rgba(246, 242, 232, 0.95));
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 28px;
      box-shadow: var(--shadow);
      margin-bottom: 24px;
    }
    .hero h1 { margin: 0 0 8px; font-size: 36px; }
    .hero p { margin: 0; color: var(--muted); font-size: 17px; line-height: 1.6; }
    .grid { display: grid; gap: 16px; }
    .cards { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 20px 0 26px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: var(--shadow);
    }
    .card h3, .card h2 { margin: 0 0 10px; font-size: 18px; }
    .card .big { font-size: 30px; font-weight: 700; margin-bottom: 4px; }
    .muted { color: var(--muted); }
    .list { display: grid; gap: 14px; }
    .row {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: var(--shadow);
    }
    .row h2, .row h3 { margin: 0 0 8px; font-size: 22px; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; }
    .reason-list { display: grid; gap: 8px; margin-top: 12px; }
    .reason-item {
      padding: 10px 12px;
      border-radius: 14px;
      background: rgba(21, 94, 239, 0.06);
      border: 1px solid rgba(21, 94, 239, 0.12);
    }
    .reason-item strong { display: block; margin-bottom: 4px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
    }
    .badge.warn { background: #fff3da; color: var(--warn); }
    .badge.danger { background: #ffe1e1; color: var(--danger); }
    .badge.success { background: #ddf6e8; color: var(--success); }
    .section { margin-top: 24px; }
    .section h2 { margin: 0 0 12px; font-size: 26px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      overflow: hidden;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--panel);
    }
    th, td {
      text-align: left;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(217, 210, 192, 0.7);
      vertical-align: top;
    }
    th { background: rgba(21, 94, 239, 0.06); }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.55;
    }
    .timeline { display: grid; gap: 12px; }
    .timeline-item {
      padding: 14px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.7);
    }
    .timeline-item header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 12px;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.08em;
    }
    .finding { padding: 16px; border-radius: 18px; border: 1px solid var(--border); background: #fff; }
    .finding h3 { margin: 0 0 8px; font-size: 18px; }
    .finding ul { margin: 8px 0 0 18px; padding: 0; }
    .stack { display: grid; gap: 12px; }
    .small { font-size: 13px; }
    .mono { font-family: var(--mono); }
    .two-col { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .step-list { display: grid; gap: 12px; }
    .step-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .step-card header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      align-items: center;
    }
    .step-card h3 { margin: 0; font-size: 18px; }
    .step-card p { margin: 6px 0 0; }
    .advisor-shell { display: grid; gap: 16px; }
    .advisor-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 14px; }
    .button {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-size: 14px;
      font-weight: 700;
      box-shadow: var(--shadow);
    }
    .button:disabled { opacity: 0.6; cursor: wait; }
    .advisor-empty {
      border: 1px dashed var(--border);
      border-radius: 18px;
      background: rgba(255,255,255,0.55);
      padding: 18px;
    }
    .advisor-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .advisor-reason { border: 1px solid var(--border); border-radius: 16px; background: white; padding: 14px; }
    .advisor-reason h3 { margin: 0 0 6px; font-size: 17px; }
    .advisor-reason ul { margin: 10px 0 0 18px; padding: 0; }
    .advisor-banner {
      padding: 14px 16px;
      border-radius: 16px;
      background: rgba(21, 94, 239, 0.08);
      border: 1px solid rgba(21, 94, 239, 0.16);
    }
    .advisor-error {
      padding: 14px 16px;
      border-radius: 16px;
      background: #ffe7e7;
      border: 1px solid #efc0c0;
      color: var(--danger);
    }
  </style>
</head>
<body>
  <main class="page">${body}</main>
</body>
</html>`;
}

function renderConversationSummary(conversation) {
  return `
    <article class="row">
      <h2><a href="./conversations/${escapeHtml(conversation.conversationId)}.html">${escapeHtml(conversation.threadName || conversation.conversationId)}</a></h2>
      <p class="muted">${escapeHtml(conversation.summary.topIssue)}</p>
      <div class="meta">
        <span class="badge">${conversation.turns.length} 个回合</span>
        <span class="badge">${formatDuration(conversation.summary.totalDurationMs)}</span>
        <span class="badge">${formatNumber(conversation.summary.totalTokens)} Token</span>
        <span class="badge">评分 ${conversation.summary.averageScore}</span>
        <span class="badge warn">${escapeHtml(conversation.turns[0]?.cwd || "未知项目")}</span>
      </div>
      <p class="small muted">更新时间 ${escapeHtml(formatDateTime(conversation.updatedAt))}</p>
    </article>
  `;
}

function summarizePrompt(text, fallback = "未记录提问内容") {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return fallback;
  }
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

function latestAssistantAnswer(turn) {
  const finalAnswer = [...(turn.assistantMessages || [])]
    .reverse()
    .find((message) => message.phase === "final_answer" && message.text?.trim());
  if (finalAnswer) {
    return finalAnswer.text.trim();
  }
  const latest = [...(turn.assistantMessages || [])]
    .reverse()
    .find((message) => message.text?.trim());
  return latest?.text?.trim() || "";
}

function summarizeEvidence(issue) {
  const evidence = issue?.evidence || [];
  if (evidence.length === 0) {
    return "暂时没有提取到直接证据。";
  }
  return evidence.slice(0, 2).join("；");
}

function renderIssueReasons(issues, limit = 2) {
  const selected = (issues || []).slice(0, limit);
  if (selected.length === 0) {
    return "";
  }
  return `
    <div class="reason-list">
      ${selected.map((issue) => `
        <div class="reason-item">
          <strong>${escapeHtml(issue.title)}</strong>
          <div class="small muted">${escapeHtml(summarizeEvidence(issue))}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTurnSummary(turn, index) {
  const issueBadges = turn.diagnosis.topIssues.map(
    (issue) => `<span class="badge danger">${escapeHtml(issue.title)}</span>`,
  ).join("");
  const title = `第 ${index + 1} 次问答`;
  const promptPreview = summarizePrompt(turn.promptText);
  return `
    <article class="row">
      <h3><a href="../turns/${escapeHtml(turn.turnId)}.html">${escapeHtml(title)}</a></h3>
      <p class="muted">${escapeHtml(promptPreview)}</p>
      <div class="meta">
        <span class="badge">${formatDuration(turn.durationMs)}</span>
        <span class="badge">${formatNumber(turn.diagnosis.tokenSummary.effective?.totalTokens || 0)} Token</span>
        <span class="badge">评分 ${turn.diagnosis.score}</span>
        <span class="badge ${turn.diagnosis.fixLoopSummary.level === "High" ? "danger" : turn.diagnosis.fixLoopSummary.level === "Medium" ? "warn" : "success"}">修复循环 ${escapeHtml(fixLoopLevelLabel(turn.diagnosis.fixLoopSummary.level))}</span>
        <span class="badge ${turn.diagnosis.contextExpansion.uniqueFilesRead > 25 ? "warn" : "success"}">上下文 ${turn.diagnosis.contextExpansion.uniqueFilesRead} 个文件</span>
      </div>
      <div class="meta">${issueBadges}</div>
      ${renderIssueReasons(turn.diagnosis.topIssues, 2)}
      <p class="small muted">开始时间 ${escapeHtml(formatDateTime(turn.startedAt))} · 回合 ID ${escapeHtml(turn.turnId)}</p>
    </article>
  `;
}

function renderFindings(turn) {
  return turn.diagnosis.topIssues.map((issue) => `
    <article class="finding">
      <h3>${escapeHtml(issue.title)}</h3>
      <p class="muted">${escapeHtml(issue.recommendation)}</p>
      <ul>
        ${issue.evidence.map((evidence) => `<li>${escapeHtml(evidence)}</li>`).join("")}
      </ul>
    </article>
  `).join("");
}

function renderToolTable(turn) {
  return `
    <table>
      <thead>
        <tr>
          <th>类型</th>
          <th>工具</th>
          <th>耗时</th>
          <th>成功</th>
          <th>命令 / 输入</th>
        </tr>
      </thead>
      <tbody>
        ${turn.diagnosis.toolSummary.toolCalls.map((toolCall) => `
          <tr>
            <td>${escapeHtml(toolCategoryLabel(toolCall.category))}</td>
            <td>${escapeHtml(toolCall.name || "未知")}</td>
            <td>${escapeHtml(formatDuration(toolCall.durationMs))}</td>
            <td>${escapeHtml(toolCall.success === false ? "否" : "是")}</td>
            <td><pre>${escapeHtml(toolCall.command || toolCall.argumentsText || "")}</pre></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderModelTable(turn) {
  const steps = turn.diagnosis.executionSummary?.modelSteps || [];
  if (steps.length === 0) {
    return `<p class="muted">这次问答没有采集到可用的模型请求日志。</p>`;
  }
  return `
    <table>
      <thead>
        <tr>
          <th>响应轮次</th>
          <th>耗时</th>
          <th>输入 Token</th>
          <th>输出 Token</th>
          <th>推理 Token</th>
          <th>缓存命中</th>
        </tr>
      </thead>
      <tbody>
        ${steps.map((step) => `
          <tr>
            <td>${escapeHtml(step.title)}</td>
            <td>${escapeHtml(formatDuration(step.durationMs))}</td>
            <td>${formatNumber(step.inputTokens)}</td>
            <td>${formatNumber(step.outputTokens)}</td>
            <td>${formatNumber(step.reasoningTokens)}</td>
            <td>${formatNumber(step.cachedTokens)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderExecutionSteps(turn) {
  const steps = turn.diagnosis.executionSummary?.orderedSteps || [];
  if (steps.length === 0) {
    return `<p class="muted">这次问答没有采集到足够的执行步骤日志。</p>`;
  }
  return `
    <div class="step-list">
      ${steps.map((step) => `
        <article class="step-card">
          <header>
            <h3>步骤 ${step.order} · ${escapeHtml(step.type === "model" ? "模型响应" : "工具执行")}</h3>
            <span class="small muted">${escapeHtml(formatDateTime(step.timestamp))}</span>
          </header>
          <p>${escapeHtml(step.title)}</p>
          <div class="meta">
            <span class="badge">${escapeHtml(formatDuration(step.durationMs))}</span>
            ${step.type === "model"
              ? `<span class="badge">输入 ${formatNumber(step.inputTokens)} Token</span>
                 <span class="badge">输出 ${formatNumber(step.outputTokens)} Token</span>
                 <span class="badge">推理 ${formatNumber(step.reasoningTokens)} Token</span>`
              : `<span class="badge">${escapeHtml(toolCategoryLabel(step.category))}</span>
                 <span class="badge ${step.success === false ? "danger" : "success"}">${escapeHtml(step.success === false ? "失败" : "成功")}</span>`}
          </div>
          ${step.type === "model"
            ? `<pre>${escapeHtml(`${step.model || "未知模型"} · ${step.endpoint || "未知接口"}${step.statusCode ? ` · 状态 ${step.statusCode}` : ""}`)}</pre>`
            : `<pre>${escapeHtml(step.command || "未记录命令或输入")}</pre>`}
          ${step.type === "tool" && step.outputSnippet
            ? `<p class="small muted">输出摘要</p><pre>${escapeHtml(step.outputSnippet)}</pre>`
            : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderPromptAnalysis(turn) {
  const promptSummary = turn.diagnosis.promptSummary;
  const rows = [
    ["需求长度", `${promptSummary.promptLength} 字符`, promptSummary.lengthLabel],
    ["指定目标文件 / 组件", promptSummary.hasFileTarget ? "有" : "没有", promptSummary.hasFileTarget ? "AI 更容易直接定位" : "AI 需要先自己找目标"],
    ["限制修改范围", promptSummary.hasScopeBoundary ? "有" : "没有", promptSummary.hasScopeBoundary ? "搜索边界更清楚" : "AI 更容易扩大搜索范围"],
    ["给出验收标准", promptSummary.hasAcceptance ? "有" : "没有", promptSummary.hasAcceptance ? "更容易判断何时完成" : "AI 可能反复检查和补充"],
    ["后续读取文件数", `${promptSummary.consequence.uniqueFilesRead} 个`, "这是这次提问后真正拉进上下文的文件数"],
    ["全项目搜索次数", `${promptSummary.consequence.projectWideReadCount} 次`, "例如 `rg --files`、`find .` 这类全量扫描"],
    ["重复读取文件数", `${promptSummary.consequence.repeatedFiles} 个`, "重复读取通常意味着定位不够准"],
    ["疑似无关读取数", `${promptSummary.consequence.unrelatedReadCount} 个`, "读取了但没有明显进入修改链路"],
  ];

  return `
    <div class="two-col">
      <article class="card">
        <h2>为什么判断需求描述放大了探索成本</h2>
        <table>
          <thead>
            <tr><th>检查项</th><th>结果</th><th>影响</th></tr>
          </thead>
          <tbody>
            ${rows.map(([label, value, reason]) => `
              <tr>
                <td>${escapeHtml(label)}</td>
                <td>${escapeHtml(value)}</td>
                <td>${escapeHtml(reason)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </article>
      <article class="card">
        <h2>直接原因</h2>
        ${promptSummary.issues.length > 0
          ? `<ul>${promptSummary.issues.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          : `<p class="muted">这次提问本身没有明显的描述问题。</p>`}
        <h2>因此发生了什么</h2>
        <ul>
          <li>AI 后续读取了 ${promptSummary.consequence.uniqueFilesRead} 个文件。</li>
          <li>AI 做了 ${promptSummary.consequence.projectWideReadCount} 次全项目搜索。</li>
          <li>有 ${promptSummary.consequence.repeatedFiles} 个文件被重复读取。</li>
          <li>疑似有 ${promptSummary.consequence.unrelatedReadCount} 个读取没有进入后续修改链路。</li>
        </ul>
      </article>
    </div>
  `;
}

function renderAdvisorSection(turn) {
  return `
    <section class="section">
      <h2>AI 复盘建议</h2>
      <div
        id="advisor-root"
        class="advisor-shell"
        data-turn-id="${escapeHtml(turn.turnId)}"
      >
        <article class="advisor-empty">
          <strong>还没有生成 AI 复盘建议。</strong>
          <p class="muted">点击按钮后，会基于这次问答的提示词、执行步骤、关键日志和相关代码片段，生成一份更省时间、更省 Token 的重写建议。</p>
          <div class="advisor-actions">
            <button id="advisor-generate-button" class="button" type="button">生成 AI 复盘建议</button>
            <span id="advisor-status" class="small muted">需要通过 <span class="mono">codex-meter open</span> 打开的本地网页，按钮才能工作。</span>
          </div>
        </article>
      </div>
      <script>
        (() => {
          const root = document.getElementById("advisor-root");
          if (!root) return;
          const turnId = root.dataset.turnId;
          const button = document.getElementById("advisor-generate-button");
          const status = document.getElementById("advisor-status");

          function escapeHtml(value) {
            return String(value ?? "")
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&#39;");
          }

          function renderReasonList(title, reasons) {
            if (!Array.isArray(reasons) || reasons.length === 0) {
              return '<article class="advisor-reason"><h3>' + escapeHtml(title) + '</h3><p class="muted">暂无足够证据。</p></article>';
            }
            return reasons.map((reason) => {
              const evidence = Array.isArray(reason.evidence) && reason.evidence.length > 0
                ? '<ul>' + reason.evidence.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
                : '<p class="muted">暂无额外证据。</p>';
              return '<article class="advisor-reason">'
                + '<h3>' + escapeHtml(title + '：' + (reason.title || '未命名原因')) + '</h3>'
                + '<p>' + escapeHtml(reason.because || '无法确认') + '</p>'
                + evidence
                + '<p class="small muted">建议：' + escapeHtml(reason.suggestion || '暂无建议') + '</p>'
                + '</article>';
            }).join('');
          }

          function renderAdvisor(data) {
            const advisor = data && data.advisor ? data.advisor : null;
            if (!advisor) {
              return;
            }
            const promptProblems = Array.isArray(advisor.prompt_problems) && advisor.prompt_problems.length > 0
              ? '<ul>' + advisor.prompt_problems.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
              : '<p class="muted">这次没有明确识别到额外的提示词问题。</p>';
            const expectedSavings = Array.isArray(advisor.expected_savings) && advisor.expected_savings.length > 0
              ? '<ul>' + advisor.expected_savings.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
              : '<p class="muted">暂无明确节省项。</p>';
            const evidence = Array.isArray(advisor.evidence) && advisor.evidence.length > 0
              ? '<ul>' + advisor.evidence.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
              : '<p class="muted">暂无直接证据。</p>';

            root.innerHTML = ''
              + '<div class="advisor-banner"><strong>一句话总结：</strong> ' + escapeHtml(advisor.summary || '暂无结论') + '</div>'
              + '<div class="advisor-grid">'
              + renderReasonList('为什么慢', advisor.slow_reasons)
              + renderReasonList('为什么 Token 高', advisor.token_reasons)
              + '</div>'
              + '<div class="advisor-grid">'
              + '<article class="card"><h2>原始提示词的问题</h2>' + promptProblems + '</article>'
              + '<article class="card"><h2>为什么这个新提示词会更省</h2>' + expectedSavings + '</article>'
              + '</div>'
              + '<article class="card"><h2>推荐重写后的提示词</h2><pre>' + escapeHtml(advisor.better_prompt || '') + '</pre></article>'
              + '<article class="card"><h2>复盘证据</h2>' + evidence + '<p class="small muted">生成时间：' + escapeHtml(data.generatedAt || '未知') + '</p></article>'
              + '<div class="advisor-actions"><button id="advisor-regenerate-button" class="button" type="button">重新生成 AI 复盘建议</button><span class="small muted">会覆盖当前这次问答已有的 AI 复盘缓存。</span></div>';

            const regenerateButton = document.getElementById("advisor-regenerate-button");
            if (regenerateButton) {
              regenerateButton.addEventListener("click", () => generateAdvisor(true));
            }
          }

          function setLoading(message) {
            if (button) {
              button.disabled = true;
              button.textContent = "生成中...";
            }
            const regenerateButton = document.getElementById("advisor-regenerate-button");
            if (regenerateButton) {
              regenerateButton.disabled = true;
              regenerateButton.textContent = "生成中...";
            }
            if (status) {
              status.textContent = message;
            }
          }

          function setIdle(message) {
            const targetButton = document.getElementById("advisor-generate-button");
            if (targetButton) {
              targetButton.disabled = false;
              targetButton.textContent = "生成 AI 复盘建议";
            }
            const regenerateButton = document.getElementById("advisor-regenerate-button");
            if (regenerateButton) {
              regenerateButton.disabled = false;
              regenerateButton.textContent = "重新生成 AI 复盘建议";
            }
            const targetStatus = document.getElementById("advisor-status");
            if (targetStatus && message) {
              targetStatus.textContent = message;
            }
          }

          function showError(message) {
            const errorHtml = '<div class="advisor-error"><strong>生成失败：</strong> ' + escapeHtml(message) + '</div>';
            root.insertAdjacentHTML('beforeend', errorHtml);
            setIdle("生成失败，可以稍后重试。");
          }

          function friendlyFetchError(error) {
            const raw = String(error && error.message ? error.message : error || "");
            if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
              return "当前页面没有连上 codex-meter 本地服务。请先运行 codex-meter open；如果还不行，请查看 .codex/codex-meter/logs/server.log。";
            }
            return raw || "生成失败";
          }

          async function fetchExisting() {
            if (location.protocol === "file:") {
              setIdle("当前是本地文件打开模式，无法直接调用 AI 复盘。请用 codex-meter open 打开网页。");
              return;
            }
            try {
              const response = await fetch('/api/turns/' + encodeURIComponent(turnId) + '/advisor');
              if (response.status === 404) {
                setIdle("还没有这次问答的 AI 复盘缓存。");
                return;
              }
              const result = await response.json();
              if (response.ok && result.status === "ready" && result.data) {
                renderAdvisor(result.data);
              } else {
                setIdle("还没有这次问答的 AI 复盘缓存。");
              }
            } catch {
              setIdle("当前页面没有连到本地服务，请用 codex-meter open 打开。");
            }
          }

          async function generateAdvisor(isRegenerate) {
            if (location.protocol === "file:") {
              showError("当前是本地文件打开模式，请改用 codex-meter open 打开。");
              return;
            }
            setLoading(isRegenerate ? "正在重新生成 AI 复盘建议，通常需要几十秒到几分钟。" : "正在生成 AI 复盘建议，通常需要几十秒到几分钟。");
            const oldError = root.querySelector(".advisor-error");
            if (oldError) {
              oldError.remove();
            }
            try {
              const response = await fetch('/api/turns/' + encodeURIComponent(turnId) + '/advisor', {
                method: 'POST',
              });
              const result = await response.json();
              if (!response.ok || result.status !== "ready" || !result.data) {
                throw new Error(result.message || "生成失败");
              }
              renderAdvisor(result.data);
            } catch (error) {
              showError(friendlyFetchError(error));
            }
          }

          if (button) {
            button.addEventListener("click", () => generateAdvisor(false));
          }
          fetchExisting();
        })();
      </script>
    </section>
  `;
}

function renderTimeline(turn) {
  return turn.timeline.map((item) => `
    <article class="timeline-item">
      <header>
        <span>${escapeHtml(timelineTypeLabel(item.type))}</span>
        <span>${escapeHtml(formatDateTime(item.timestamp))}</span>
      </header>
      <pre>${escapeHtml(typeof item.content === "string" ? item.content : JSON.stringify(item.content || item.summary || {}, null, 2))}</pre>
    </article>
  `).join("");
}

export function renderSite(paths, conversations) {
  const conversationList = [...conversations].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));

  writeText(
    path.join(paths.siteRoot, "index.html"),
    pageChrome(
      "codex-meter 历史记录",
      `
      <section class="hero">
        <h1>codex-meter 历史记录</h1>
        <p>浏览本机 Codex 对话历史，查看每个回合的诊断结果，并追踪时间和 Token 消耗去了哪里。</p>
      </section>
      <section class="grid cards">
        <article class="card">
          <div class="big">${conversationList.length}</div>
          <div class="muted">已收录对话</div>
        </article>
        <article class="card">
          <div class="big">${formatNumber(conversationList.reduce((sum, conversation) => sum + (conversation.summary?.totalTokens || 0), 0))}</div>
          <div class="muted">累计 Token</div>
        </article>
        <article class="card">
          <div class="big">${formatDuration(conversationList.reduce((sum, conversation) => sum + (conversation.summary?.totalDurationMs || 0), 0))}</div>
          <div class="muted">累计诊断耗时</div>
        </article>
        <article class="card">
          <div class="big">${Math.round(conversationList.reduce((sum, conversation) => sum + (conversation.summary?.averageScore || 0), 0) / (conversationList.length || 1))}</div>
          <div class="muted">平均诊断评分</div>
        </article>
      </section>
      <section class="section">
        <h2>历史对话</h2>
        <div class="list">${conversationList.map(renderConversationSummary).join("")}</div>
      </section>
    `,
    ),
  );

  for (const conversation of conversationList) {
    writeText(
      path.join(paths.siteConversationDir, `${conversation.conversationId}.html`),
      pageChrome(
        `${conversation.threadName} - codex-meter 历史记录`,
        `
        <section class="hero">
          <p><a href="../index.html">返回历史</a></p>
          <h1>${escapeHtml(conversation.threadName || conversation.conversationId)}</h1>
          <p>${escapeHtml(conversation.summary.topIssue)}</p>
          <div class="meta">
            <span class="badge">${conversation.turns.length} 个回合</span>
            <span class="badge">${formatDuration(conversation.summary.totalDurationMs)}</span>
            <span class="badge">${formatNumber(conversation.summary.totalTokens)} Token</span>
            <span class="badge">评分 ${conversation.summary.averageScore}</span>
          </div>
          <p class="small muted mono">${escapeHtml(conversation.conversationId)}</p>
        </section>
        <section class="section">
          <h2>回合列表</h2>
          <div class="list">${conversation.turns.map((turn, index) => renderTurnSummary(turn, index)).join("")}</div>
        </section>
      `,
      ),
    );

    for (const [turnIndex, turn] of conversation.turns.entries()) {
      const tokenSummary = turn.diagnosis.tokenSummary.effective || {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
      };
      const toolSummary = turn.diagnosis.toolSummary;
      const answerText = latestAssistantAnswer(turn);
      writeText(
        path.join(paths.siteTurnDir, `${turn.turnId}.html`),
        pageChrome(
          `第 ${turnIndex + 1} 次问答 - codex-meter`,
          `
          <section class="hero">
            <p><a href="../conversations/${escapeHtml(conversation.conversationId)}.html">返回对话</a></p>
            <h1>第 ${turnIndex + 1} 次问答</h1>
            <p>${escapeHtml(turn.diagnosis.topIssues[0]?.title || "暂无诊断结果")}</p>
            <div class="meta">
              <span class="badge">${formatDuration(turn.durationMs)}</span>
              <span class="badge">${formatNumber(tokenSummary.totalTokens)} Token</span>
              <span class="badge">需求评分 ${turn.diagnosis.promptSummary.score}</span>
              <span class="badge">环境评分 ${turn.diagnosis.environmentSummary.score}</span>
              <span class="badge ${turn.diagnosis.fixLoopSummary.level === "High" ? "danger" : turn.diagnosis.fixLoopSummary.level === "Medium" ? "warn" : "success"}">修复循环 ${escapeHtml(fixLoopLevelLabel(turn.diagnosis.fixLoopSummary.level))}</span>
            </div>
            <p class="small muted">${escapeHtml(turn.cwd || "未知项目")} · ${escapeHtml(turn.model || "未知模型")} · ${escapeHtml(formatDateTime(turn.startedAt))}</p>
          </section>

          <section class="grid cards">
            <article class="card">
              <h3>总耗时</h3>
              <div class="big">${formatDuration(turn.durationMs)}</div>
              <div class="muted">${toolSummary.toolCalls.length} 次工具调用，${turn.diagnosis.modelSummary.requestCount} 次模型请求</div>
            </article>
            <article class="card">
              <h3>Token 消耗</h3>
              <div class="big">${formatNumber(tokenSummary.totalTokens)}</div>
              <div class="muted">输入 ${formatNumber(tokenSummary.inputTokens)} · 输出 ${formatNumber(tokenSummary.outputTokens)}</div>
            </article>
            <article class="card">
              <h3>AI 做了什么</h3>
              <div class="big">${turn.diagnosis.executionSummary.orderedSteps.length}</div>
              <div class="muted">共记录 ${turn.diagnosis.executionSummary.modelSteps.length} 次模型响应、${toolSummary.toolCalls.length} 次工具执行</div>
            </article>
            <article class="card">
              <h3>主要瓶颈</h3>
              <div class="big">${escapeHtml(turn.diagnosis.topIssues[0]?.title || "未知")}</div>
              <div class="muted">当前排名第一的问题</div>
            </article>
          </section>

          ${renderAdvisorSection(turn)}

          <section class="section two-col">
            <article class="card">
              <h2>本次提问</h2>
              <pre>${escapeHtml(turn.promptText || "本地日志未记录到提问正文。")}</pre>
            </article>
            <article class="card">
              <h2>AI 最终答复</h2>
              <pre>${escapeHtml(answerText || "本地日志没有保存最终答复正文，只记录到了执行过程。")}</pre>
            </article>
          </section>

          <section class="section">
            <h2>AI 做了什么</h2>
            <p class="muted">下面按时间顺序还原这次提问之后，AI 的每一步动作、耗时，以及能从本机日志恢复到的 Token 消耗。</p>
            ${renderExecutionSteps(turn)}
          </section>

          <section class="section">
            ${renderPromptAnalysis(turn)}
          </section>

          <section class="section">
            <h2>诊断结论</h2>
            <div class="stack">${renderFindings(turn)}</div>
          </section>

          <section class="section">
            <h2>Token 去向</h2>
            <table>
              <thead>
                <tr><th>类型</th><th>Token</th><th>占比</th></tr>
              </thead>
              <tbody>
                <tr><td>输入</td><td>${formatNumber(tokenSummary.inputTokens)}</td><td>${percent(tokenSummary.inputTokens, tokenSummary.totalTokens || 1)}%</td></tr>
                <tr><td>输出</td><td>${formatNumber(tokenSummary.outputTokens)}</td><td>${percent(tokenSummary.outputTokens, tokenSummary.totalTokens || 1)}%</td></tr>
                <tr><td>推理</td><td>${formatNumber(tokenSummary.reasoningTokens)}</td><td>${percent(tokenSummary.reasoningTokens, tokenSummary.totalTokens || 1)}%</td></tr>
                <tr><td>缓存命中</td><td>${formatNumber(tokenSummary.cachedTokens)}</td><td>占输入的 ${percent(tokenSummary.cachedTokens, tokenSummary.inputTokens || 1)}%</td></tr>
              </tbody>
            </table>
          </section>

          <section class="section">
            <h2>模型响应明细</h2>
            ${renderModelTable(turn)}
          </section>

          <section class="section">
            <h2>工具统计</h2>
            ${renderToolTable(turn)}
          </section>

          <section class="section">
            <h2>上下文膨胀证据</h2>
            <table>
              <thead>
                <tr><th>指标</th><th>数值</th><th>说明</th></tr>
              </thead>
              <tbody>
                <tr><td>读取的不同文件数</td><td>${turn.diagnosis.contextExpansion.uniqueFilesRead}</td><td>本回合在读取 / 搜索命令里出现过的不同文件总数</td></tr>
                <tr><td>重复读取文件数</td><td>${turn.diagnosis.contextExpansion.repeatedFiles.length}</td><td>被重复读取的文件数量</td></tr>
                <tr><td>全项目范围搜索次数</td><td>${turn.diagnosis.contextExpansion.projectWideReadCount}</td><td>如 <span class="mono">rg --files</span> 或 <span class="mono">find .</span> 之类的命令</td></tr>
                <tr><td>疑似无关读取数</td><td>${turn.diagnosis.contextExpansion.unrelatedReadCount}</td><td>读取后没有明显进入后续修改链路的文件</td></tr>
              </tbody>
            </table>
          </section>

          <section class="section">
            <h2>原始时间线</h2>
            <div class="timeline">${renderTimeline(turn)}</div>
          </section>
        `,
        ),
      );
    }
  }
}
