import fs from "node:fs";
import path from "node:path";

import {
  clamp,
  existingFileSize,
  formatDuration,
  groupBy,
  normalizeWhitespace,
  percent,
  sumBy,
  truncate,
  unique,
} from "./utils.js";

const HEAVY_COMMAND_PATTERNS = [
  /flutter analyze/,
  /pod install/,
  /gradle/,
  /npm install/,
  /yarn install/,
  /pnpm install/,
  /build_runner/,
  /xcodebuild/,
  /cargo test/,
  /pytest/,
];

function classifyToolCall(toolCall) {
  if (toolCall.name === "apply_patch") {
    return "Edit";
  }
  if (toolCall.name !== "exec_command") {
    return "Other";
  }
  const args = toolCall.argumentsJson || safeParseJson(toolCall.argumentsText);
  const command = args?.cmd || toolCall.command || toolCall.argumentsText || "";
  toolCall.command = command;
  const normalized = command.toLowerCase();

  if (/\brg\s+--files\b|\bfind\b/.test(normalized)) {
    return "Search";
  }
  if (/\brg\b|\bgrep\b/.test(normalized)) {
    return "Grep";
  }
  if (/\bsed\b|\bcat\b|\bhead\b|\btail\b|\bless\b|\bwc\b/.test(normalized)) {
    return "Read";
  }
  if (/\bapply_patch\b|\bmv\b|\bcp\b|\bperl\s+-0pi\b|\bsed\s+-i\b/.test(normalized)) {
    return "Edit";
  }
  return "Bash";
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeModelName(model) {
  if (!model) {
    return null;
  }
  const text = String(model);
  const match = text.match(/(gpt-[^:\s"}]+)/i);
  return match?.[1] || text;
}

function extractPathsFromCommand(command, cwd) {
  const matches = command.match(/(?:\/[^\s'"]+|(?:\.{1,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9_-]+)?)/g) || [];
  const files = [];
  for (const match of matches) {
    const candidate = path.isAbsolute(match) ? match : path.resolve(cwd || process.cwd(), match);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        files.push(candidate);
      }
    } catch {
      continue;
    }
  }
  return unique(files);
}

function extractEditedFiles(toolCall) {
  if (toolCall.name !== "apply_patch") {
    return [];
  }
  const patchText = toolCall.argumentsText || "";
  const files = [];
  const regex = /\*\*\* (?:Add|Delete|Update) File: (.+)/g;
  for (const match of patchText.matchAll(regex)) {
    files.push(match[1].trim());
  }
  return unique(files);
}

function applyOtelEventsToTurn(turn) {
  for (const event of turn.otel.apiRequests) {
    if (event.model && !turn.model) {
      turn.model = normalizeModelName(event.model);
    }
  }
  for (const event of turn.otel.promptEvents) {
    if (event.promptLength != null && !turn.promptLength) {
      turn.promptLength = event.promptLength;
    }
  }
}

function summarizeTools(turn) {
  const toolCalls = turn.toolCalls.map((toolCall) => {
    const category = classifyToolCall(toolCall);
    const command =
      toolCall.command ||
      toolCall.argumentsJson?.cmd ||
      toolCall.argumentsJson?.command ||
      toolCall.argumentsText ||
      "";
    const readFiles = category === "Read" || category === "Search" || category === "Grep"
      ? extractPathsFromCommand(command, turn.cwd)
      : [];
    const editedFiles = extractEditedFiles(toolCall);
    return {
      ...toolCall,
      category,
      command,
      readFiles,
      editedFiles,
      durationMs: toolCall.durationMs ?? 0,
      success: toolCall.success,
      outputSnippet: toolCall.outputSnippet || truncate(toolCall.output || "", 240),
    };
  });

  const byCategory = groupBy(toolCalls, (toolCall) => toolCall.category);
  const categories = {};
  for (const [category, items] of byCategory.entries()) {
    categories[category] = {
      count: items.length,
      totalDurationMs: sumBy(items, (item) => item.durationMs || 0),
      successRate: percent(
        items.filter((item) => item.success !== false).length,
        items.length || 1,
      ),
    };
  }

  return {
    toolCalls,
    categories,
    totalDurationMs: sumBy(toolCalls, (toolCall) => toolCall.durationMs || 0),
    slowestCalls: [...toolCalls]
      .sort((left, right) => (right.durationMs || 0) - (left.durationMs || 0))
      .slice(0, 5),
  };
}

function computeTokenTotals(turn) {
  const responseEvents = turn.otel.sseEvents.filter(
    (event) => event.eventKind === "response.completed" && event.inputTokenCount != null,
  );
  const responseTotals = {
    inputTokens: sumBy(responseEvents, (event) => event.inputTokenCount || 0),
    outputTokens: sumBy(responseEvents, (event) => event.outputTokenCount || 0),
    cachedTokens: sumBy(responseEvents, (event) => event.cachedTokenCount || 0),
    reasoningTokens: sumBy(responseEvents, (event) => event.reasoningTokenCount || 0),
    toolTokens: sumBy(responseEvents, (event) => event.toolTokenCount || 0),
  };
  responseTotals.totalTokens =
    responseTotals.inputTokens +
    responseTotals.outputTokens +
    responseTotals.reasoningTokens;

  const snapshots = turn.tokenSnapshots
    .map((snapshot) => snapshot.info?.total_token_usage)
    .filter(Boolean);

  const earliest = snapshots[0] || null;
  const latest = snapshots[snapshots.length - 1] || null;
  let deltaTotals = null;
  if (earliest && latest) {
    deltaTotals = {
      inputTokens: Math.max(0, (latest.input_tokens || 0) - (earliest.input_tokens || 0)),
      cachedTokens: Math.max(
        0,
        (latest.cached_input_tokens || 0) - (earliest.cached_input_tokens || 0),
      ),
      outputTokens: Math.max(0, (latest.output_tokens || 0) - (earliest.output_tokens || 0)),
      reasoningTokens: Math.max(
        0,
        (latest.reasoning_output_tokens || 0) - (earliest.reasoning_output_tokens || 0),
      ),
      totalTokens: Math.max(0, (latest.total_tokens || 0) - (earliest.total_tokens || 0)),
    };
  }

  return {
    responseTotals,
    deltaTotals,
    effective: responseTotals.totalTokens > 0 ? responseTotals : deltaTotals,
  };
}

function analyzeContextExpansion(turn, toolSummary) {
  const readCalls = toolSummary.toolCalls.filter((toolCall) =>
    toolCall.category === "Read" ||
    toolCall.category === "Search" ||
    toolCall.category === "Grep",
  );
  const readFiles = readCalls.flatMap((toolCall) => toolCall.readFiles);
  const fileCounts = new Map();
  for (const filePath of readFiles) {
    fileCounts.set(filePath, (fileCounts.get(filePath) || 0) + 1);
  }
  const repeatedFiles = [...fileCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([filePath, count]) => ({ filePath, count }));
  const largeFiles = [...fileCounts.keys()]
    .map((filePath) => ({ filePath, size: existingFileSize(filePath) || 0 }))
    .filter((item) => item.size > 0)
    .sort((left, right) => right.size - left.size)
    .slice(0, 8);
  const totalBytes = sumBy(largeFiles, (item) => item.size);
  const biggestFiles = largeFiles.map((item) => ({
    ...item,
    percent: percent(item.size, totalBytes || 1),
  }));

  const searchBreadth = readCalls.filter((toolCall) =>
    /\brg\s+--files\b|\bfind\b/.test(toolCall.command?.toLowerCase() || ""),
  ).length;

  const projectWideReads = readCalls.filter((toolCall) =>
    /\brg\s+--files\b/.test(toolCall.command?.toLowerCase() || "") ||
    /\bfind\s+\.\b/.test(toolCall.command?.toLowerCase() || "") ||
    /\bfind\s+\.\.\b/.test(toolCall.command?.toLowerCase() || ""),
  );

  const editedFiles = unique(toolSummary.toolCalls.flatMap((toolCall) => toolCall.editedFiles));
  const unrelatedReads = [...fileCounts.keys()].filter((filePath) =>
    editedFiles.length > 0 && !editedFiles.some((editedFile) => filePath.endsWith(path.basename(editedFile))),
  );

  return {
    totalReadCalls: readCalls.length,
    uniqueFilesRead: fileCounts.size,
    repeatedFiles,
    biggestFiles,
    projectWideReadCount: projectWideReads.length,
    searchBreadth,
    unrelatedReadCount: unrelatedReads.length,
    unrelatedReads: unrelatedReads.slice(0, 12),
  };
}

function analyzePrompt(turn, contextExpansion) {
  const prompt = turn.promptText || "";
  let score = 65;
  const issues = [];
  const positives = [];
  let lengthLabel = "较长";

  if (prompt.length < 24) {
    score -= 20;
    lengthLabel = "过短";
    issues.push("需求描述太短，无法清楚锚定目标。");
  } else if (prompt.length < 80) {
    score -= 10;
    lengthLabel = "偏短";
    issues.push("需求描述虽然简洁，但边界信息可能不足。");
  } else {
    positives.push("需求描述长度足以说明任务。");
  }

  const hasFileTarget = /[/\\][^ \n]+|\b[a-z0-9_-]+\.(dart|ts|tsx|js|jsx|py|json|md|swift|kt)\b/i.test(prompt);
  if (hasFileTarget) {
    score += 12;
    positives.push("需求描述指向了具体文件或代码目标。");
  } else {
    score -= 18;
    issues.push("需求描述没有指向具体文件、页面或组件。");
  }

  const hasScopeBoundary = /(only|just|不要|只|仅|limit|avoid|don'?t|without refactor|不需要重构)/i.test(prompt);
  if (hasScopeBoundary) {
    score += 10;
    positives.push("需求描述包含了范围约束。");
  } else {
    score -= 10;
    issues.push("需求描述没有明确限制搜索或修改范围。");
  }

  const hasAcceptance = /(验收|确保|should|expected|confirm|verify|完成标准)/i.test(prompt);
  if (hasAcceptance) {
    score += 10;
    positives.push("需求描述给出了部分完成标准。");
  } else {
    score -= 10;
    issues.push("需求描述没有定义验收标准。");
  }

  if (contextExpansion.projectWideReadCount > 0 && !hasFileTarget) {
    score -= 8;
    issues.push("出现大范围项目搜索，可能是因为需求描述过于模糊。");
  }

  return {
    score: clamp(score, 0, 100),
    promptLength: prompt.length,
    lengthLabel,
    hasFileTarget,
    hasScopeBoundary,
    hasAcceptance,
    consequence: {
      uniqueFilesRead: contextExpansion.uniqueFilesRead,
      projectWideReadCount: contextExpansion.projectWideReadCount,
      repeatedFiles: contextExpansion.repeatedFiles.length,
      unrelatedReadCount: contextExpansion.unrelatedReadCount,
    },
    issues,
    positives,
  };
}

function analyzeEnvironment(toolSummary) {
  const bashCalls = toolSummary.toolCalls.filter((toolCall) => toolCall.category === "Bash");
  const heavyCommands = bashCalls
    .filter((toolCall) =>
      HEAVY_COMMAND_PATTERNS.some((pattern) => pattern.test(toolCall.command?.toLowerCase() || "")),
    )
    .sort((left, right) => (right.durationMs || 0) - (left.durationMs || 0));
  const totalHeavyMs = sumBy(heavyCommands, (toolCall) => toolCall.durationMs || 0);
  const score = clamp(100 - Math.round(totalHeavyMs / 3000) - heavyCommands.length * 6, 0, 100);
  return {
    score,
    heavyCommands: heavyCommands.slice(0, 8),
    totalHeavyMs,
  };
}

function analyzeFixLoop(turn, toolSummary) {
  const failedCommands = toolSummary.toolCalls.filter((toolCall) => toolCall.success === false);
  const commandCounts = new Map();
  for (const toolCall of toolSummary.toolCalls) {
    if (!toolCall.command) {
      continue;
    }
    commandCounts.set(toolCall.command, (commandCounts.get(toolCall.command) || 0) + 1);
  }
  const repeatedCommands = [...commandCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([command, count]) => ({
      command: truncate(command, 180),
      count,
    }))
    .sort((left, right) => right.count - left.count);

  const editCounts = new Map();
  for (const toolCall of toolSummary.toolCalls) {
    for (const filePath of toolCall.editedFiles) {
      editCounts.set(filePath, (editCounts.get(filePath) || 0) + 1);
    }
  }
  const repeatedEdits = [...editCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([filePath, count]) => ({ filePath, count }))
    .sort((left, right) => right.count - left.count);

  const score = repeatedEdits.length * 16 + failedCommands.length * 12 + repeatedCommands.length * 8;
  return {
    level: score >= 50 ? "High" : score >= 20 ? "Medium" : "Low",
    repeatedCommands: repeatedCommands.slice(0, 8),
    repeatedEdits: repeatedEdits.slice(0, 8),
    failedCommands: failedCommands.slice(0, 8),
  };
}

function analyzeModel(turn) {
  const requests = turn.otel.apiRequests;
  const totalDurationMs = sumBy(requests, (request) => request.durationMs || 0);
  const slowestRequest = [...requests].sort(
    (left, right) => (right.durationMs || 0) - (left.durationMs || 0),
  )[0] || null;
  return {
    requestCount: requests.length,
    totalDurationMs,
    averageDurationMs: requests.length ? Math.round(totalDurationMs / requests.length) : 0,
    slowestRequest,
  };
}

function mergeResponseCompletedEvents(sseEvents) {
  const completedEvents = [...sseEvents]
    .filter((event) => event.eventKind === "response.completed")
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
  const merged = [];

  for (const event of completedEvents) {
    const previous = merged[merged.length - 1];
    if (previous && Math.abs((event.timestamp || 0) - (previous.timestamp || 0)) <= 1500) {
      previous.timestamp = Math.max(previous.timestamp || 0, event.timestamp || 0);
      previous.durationMs = Math.max(previous.durationMs || 0, event.durationMs || 0) || null;
      previous.inputTokenCount = previous.inputTokenCount ?? event.inputTokenCount ?? null;
      previous.outputTokenCount = previous.outputTokenCount ?? event.outputTokenCount ?? null;
      previous.cachedTokenCount = previous.cachedTokenCount ?? event.cachedTokenCount ?? null;
      previous.reasoningTokenCount = previous.reasoningTokenCount ?? event.reasoningTokenCount ?? null;
      previous.toolTokenCount = previous.toolTokenCount ?? event.toolTokenCount ?? null;
      previous.model = normalizeModelName(previous.model || event.model);
      continue;
    }
    merged.push({
      timestamp: event.timestamp || null,
      durationMs: event.durationMs ?? null,
      inputTokenCount: event.inputTokenCount ?? null,
      outputTokenCount: event.outputTokenCount ?? null,
      cachedTokenCount: event.cachedTokenCount ?? null,
      reasoningTokenCount: event.reasoningTokenCount ?? null,
      toolTokenCount: event.toolTokenCount ?? null,
      model: normalizeModelName(event.model),
    });
  }

  return merged;
}

function describeToolStep(toolCall) {
  if (toolCall.category === "Read") {
    if (toolCall.readFiles.length === 1) {
      return `读取文件 ${path.basename(toolCall.readFiles[0])}`;
    }
    if (toolCall.readFiles.length > 1) {
      return `读取 ${toolCall.readFiles.length} 个文件`;
    }
    return "读取内容";
  }
  if (toolCall.category === "Search") {
    return "搜索项目范围";
  }
  if (toolCall.category === "Grep") {
    return "搜索关键字";
  }
  if (toolCall.category === "Edit") {
    if (toolCall.editedFiles.length === 1) {
      return `修改文件 ${path.basename(toolCall.editedFiles[0])}`;
    }
    if (toolCall.editedFiles.length > 1) {
      return `修改 ${toolCall.editedFiles.length} 个文件`;
    }
    return "修改文件";
  }
  if (toolCall.category === "Bash") {
    return "执行本地命令";
  }
  return toolCall.name || "执行工具";
}

function buildExecutionSummary(turn, toolSummary) {
  const requests = [...turn.otel.apiRequests]
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0))
    .map((request) => ({
      ...request,
      model: normalizeModelName(request.model) || normalizeModelName(turn.model),
    }));
  const completions = mergeResponseCompletedEvents(turn.otel.sseEvents);
  const modelSteps = [];
  let completionIndex = 0;

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const nextRequest = requests[index + 1] || null;
    let completion = null;

    while (completionIndex < completions.length) {
      const candidate = completions[completionIndex];
      if ((candidate.timestamp || 0) < (request.timestamp || 0) - 2000) {
        completionIndex += 1;
        continue;
      }
      if (nextRequest && (candidate.timestamp || 0) > (nextRequest.timestamp || 0) + 2000) {
        break;
      }
      completion = candidate;
      completionIndex += 1;
      break;
    }

    const inputTokens = completion?.inputTokenCount ?? 0;
    const outputTokens = completion?.outputTokenCount ?? 0;
    const reasoningTokens = completion?.reasoningTokenCount ?? 0;
    const cachedTokens = completion?.cachedTokenCount ?? 0;
    const totalTokens = inputTokens + outputTokens + reasoningTokens;

    modelSteps.push({
      stepIndex: index + 1,
      type: "model",
      title: `第 ${index + 1} 次模型响应`,
      timestamp: request.timestamp || completion?.timestamp || null,
      completedAt:
        completion?.timestamp ||
        (request.timestamp != null && request.durationMs != null
          ? request.timestamp + request.durationMs
          : null),
      durationMs: completion?.durationMs ?? request.durationMs ?? null,
      model: request.model || completion?.model || normalizeModelName(turn.model),
      endpoint: request.endpoint || null,
      statusCode: request.statusCode ?? null,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens,
      totalTokens,
      toolTokens: completion?.toolTokenCount ?? 0,
    });
  }

  const toolSteps = toolSummary.toolCalls.map((toolCall, index) => ({
    stepIndex: index + 1,
    type: "tool",
    title: describeToolStep(toolCall),
    timestamp: toolCall.timestamp || null,
    durationMs: toolCall.durationMs ?? null,
    category: toolCall.category,
    name: toolCall.name || null,
    command: toolCall.command || toolCall.argumentsText || "",
    success: toolCall.success !== false,
    readFiles: toolCall.readFiles,
    editedFiles: toolCall.editedFiles,
    outputSnippet: toolCall.outputSnippet || "",
  }));

  const orderedSteps = [...modelSteps, ...toolSteps]
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0))
    .map((step, index) => ({
      ...step,
      order: index + 1,
    }));

  return {
    modelSteps,
    toolSteps,
    orderedSteps,
    totalModelTokens: sumBy(modelSteps, (step) => step.totalTokens || 0),
    totalModelDurationMs: sumBy(modelSteps, (step) => step.durationMs || 0),
    totalToolDurationMs: sumBy(toolSteps, (step) => step.durationMs || 0),
    uniqueEditedFiles: unique(toolSteps.flatMap((step) => step.editedFiles || [])),
  };
}

function buildConclusions(turn, summaries) {
  const findings = [];
  const totalDuration = turn.durationMs || 0;
  const modelPercent = percent(summaries.model.totalDurationMs, totalDuration || 1);
  const toolPercent = percent(summaries.tools.totalDurationMs, totalDuration || 1);
  const effectiveTokens = summaries.tokens.effective || {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  };

  if (summaries.context.projectWideReadCount > 0 || summaries.context.uniqueFilesRead > 25) {
    findings.push({
      title: "上下文膨胀是主要成本来源",
      severity: 90,
      evidence: [
        `本次共读取 ${summaries.context.uniqueFilesRead} 个不同文件。`,
        `执行了 ${summaries.context.projectWideReadCount} 次全项目范围搜索。`,
        `有 ${summaries.context.repeatedFiles.length} 个文件被重复读取。`,
      ],
      recommendation: "建议在需求里明确目标文件、目录或组件，并显式避免全项目探索。",
    });
  }

  if ((effectiveTokens.inputTokens || 0) > (effectiveTokens.outputTokens || 0) * 8) {
    findings.push({
      title: "输入 Token 占据了主要消耗",
      severity: 85,
      evidence: [
        `输入 Token 为 ${effectiveTokens.inputTokens || 0}，输出 Token 为 ${effectiveTokens.outputTokens || 0}。`,
        `缓存命中 Token 为 ${effectiveTokens.cachedTokens || 0}。`,
      ],
      recommendation: "建议缩小上下文范围，减少重复读文件，并在任务开始时给 Codex 更强的定位信息。",
    });
  }

  if (summaries.environment.totalHeavyMs > (totalDuration || 1) * 0.25) {
    findings.push({
      title: "本地环境命令是明显的耗时来源",
      severity: 82,
      evidence: [
        `重型本地命令累计耗时 ${formatDuration(summaries.environment.totalHeavyMs)}。`,
        `识别到 ${summaries.environment.heavyCommands.length} 个重型命令。`,
      ],
      recommendation: "建议减少全量检查、缓存重依赖，并优先采用增量分析命令。",
    });
  }

  if (summaries.fixLoop.level !== "Low") {
    findings.push({
      title: "本回合出现了修复循环迹象",
      severity: summaries.fixLoop.level === "High" ? 78 : 60,
      evidence: [
        `有 ${summaries.fixLoop.repeatedEdits.length} 个文件被重复修改。`,
        `本回合有 ${summaries.fixLoop.failedCommands.length} 个命令执行失败。`,
      ],
      recommendation: "建议更早明确最终目标，并先隔离失败文件或失败命令，避免大范围重试。",
    });
  }

  if (toolPercent > modelPercent + 15) {
    findings.push({
      title: "工具执行耗时明显高于模型响应耗时",
      severity: 70,
      evidence: [
        `工具调用占本回合耗时的 ${toolPercent}%。`,
        `模型请求占本回合耗时的 ${modelPercent}%。`,
      ],
      recommendation: "优化重点应先放在命令选择、搜索范围和本地工具链速度，而不是先归因到模型。",
    });
  } else {
    findings.push({
      title: "模型延迟不是唯一瓶颈",
      severity: 58,
      evidence: [
        `模型请求占本回合耗时的 ${modelPercent}%。`,
        `工具调用占本回合耗时的 ${toolPercent}%。`,
      ],
      recommendation: "需要同时优化需求描述清晰度和工具使用方式，仅换模型通常不如减少无效迭代有效。",
    });
  }

  const promptIssues = summaries.prompt.issues.slice(0, 2);
  if (promptIssues.length > 0) {
    const promptEvidence = [...promptIssues];
    if (!summaries.prompt.hasFileTarget) {
      promptEvidence.push("这次提问没有直接指定目标文件、页面或组件。");
    }
    if (!summaries.prompt.hasScopeBoundary) {
      promptEvidence.push("这次提问没有限制“只改哪里 / 不要改哪里”。");
    }
    if (
      summaries.context.projectWideReadCount > 0 ||
      summaries.context.uniqueFilesRead > 0
    ) {
      promptEvidence.push(
        `随后 AI 执行了 ${summaries.context.projectWideReadCount} 次全项目搜索，并读取了 ${summaries.context.uniqueFilesRead} 个文件。`,
      );
    }
    findings.push({
      title: "需求描述放大了探索成本",
      severity: 68,
      evidence: promptEvidence.slice(0, 4),
      recommendation: "建议在一开始就写清目标对象、修改边界和验收标准。",
    });
  }

  return findings
    .sort((left, right) => right.severity - left.severity)
    .slice(0, 3);
}

export function attachOtelToConversation(conversation, otelEvents) {
  const byTurnId = new Map(conversation.turns.map((turn) => [turn.turnId, turn]));
  const turnsByTime = [...conversation.turns].sort(
    (left, right) => (left.startedAt || 0) - (right.startedAt || 0),
  );

  function assignByTimestamp(event) {
    for (const turn of turnsByTime) {
      const start = turn.startedAt || 0;
      const end = turn.completedAt || Number.MAX_SAFE_INTEGER;
      if ((event.timestamp || 0) >= start && (event.timestamp || 0) <= end + 5000) {
        return turn;
      }
    }
    return turnsByTime[turnsByTime.length - 1] || null;
  }

  for (const turn of conversation.turns) {
    turn.otel = {
      apiRequests: [],
      sseEvents: [],
      toolResults: [],
      promptEvents: [],
    };
  }

  for (const event of otelEvents || []) {
    const turn = event.turnId ? byTurnId.get(event.turnId) : assignByTimestamp(event);
    if (!turn) {
      continue;
    }
    if (event.eventName === "codex.api_request") {
      turn.otel.apiRequests.push(event);
    } else if (event.eventName === "codex.tool_result") {
      turn.otel.toolResults.push(event);
    } else if (event.eventName === "codex.sse_event") {
      turn.otel.sseEvents.push(event);
    } else if (event.eventName === "codex.user_prompt") {
      turn.otel.promptEvents.push(event);
    }
  }

  for (const turn of conversation.turns) {
    const toolResultsByCall = new Map(turn.otel.toolResults.map((event) => [event.callId, event]));
    for (const toolCall of turn.toolCalls) {
      const result = toolResultsByCall.get(toolCall.callId);
      if (!result) {
        continue;
      }
      toolCall.durationMs = result.durationMs ?? toolCall.durationMs;
      toolCall.success = result.success;
      toolCall.exitCode = result.exitCode;
      toolCall.isError = result.isError;
      if (!toolCall.output && result.outputText) {
        toolCall.output = result.outputText;
      }
      if (!toolCall.argumentsText && result.argumentsText) {
        toolCall.argumentsText = result.argumentsText;
      }
      if (!toolCall.argumentsJson && result.argumentsJson) {
        toolCall.argumentsJson = result.argumentsJson;
      }
    }
    applyOtelEventsToTurn(turn);
  }
}

export function analyzeConversation(conversation) {
  for (const turn of conversation.turns) {
    const toolSummary = summarizeTools(turn);
    const tokenSummary = computeTokenTotals(turn);
    const contextExpansion = analyzeContextExpansion(turn, toolSummary);
    const promptSummary = analyzePrompt(turn, contextExpansion);
    const environmentSummary = analyzeEnvironment(toolSummary);
    const fixLoopSummary = analyzeFixLoop(turn, toolSummary);
    const modelSummary = analyzeModel(turn);
    const executionSummary = buildExecutionSummary(turn, toolSummary);

    const diagnosis = {
      toolSummary,
      tokenSummary,
      contextExpansion,
      promptSummary,
      environmentSummary,
      fixLoopSummary,
      modelSummary,
      executionSummary,
    };

    diagnosis.score = clamp(
      Math.round(
        (promptSummary.score * 0.3 +
          environmentSummary.score * 0.2 +
          (100 - Math.min(contextExpansion.uniqueFilesRead, 80)) * 0.25 +
          (fixLoopSummary.level === "Low" ? 100 : fixLoopSummary.level === "Medium" ? 70 : 40) * 0.25),
      ),
      0,
      100,
    );
    diagnosis.topIssues = buildConclusions(turn, {
      tools: toolSummary,
      tokens: tokenSummary,
      context: contextExpansion,
      prompt: promptSummary,
      environment: environmentSummary,
      fixLoop: fixLoopSummary,
      model: modelSummary,
    });

    turn.diagnosis = diagnosis;
  }

  const turns = conversation.turns;
  const topIssues = turns.flatMap((turn) => turn.diagnosis?.topIssues || []);
  const topIssue = topIssues.sort((left, right) => right.severity - left.severity)[0] || null;
  conversation.summary = {
    turnCount: turns.length,
    totalDurationMs: sumBy(turns, (turn) => turn.durationMs || 0),
    totalTokens: sumBy(
      turns,
      (turn) => turn.diagnosis?.tokenSummary?.effective?.totalTokens || 0,
    ),
    averageScore: turns.length
      ? Math.round(sumBy(turns, (turn) => turn.diagnosis?.score || 0) / turns.length)
      : 0,
    topIssue: topIssue?.title || "暂未生成诊断结论",
    topIssueRecommendation: topIssue?.recommendation || null,
  };
  return conversation;
}
