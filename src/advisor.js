import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { normalizeWhitespace, readJson, truncate, unique, writeJson } from "./utils.js";

const ADVISOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "slow_reasons",
    "token_reasons",
    "prompt_problems",
    "better_prompt",
    "expected_savings",
    "evidence",
  ],
  properties: {
    summary: { type: "string" },
    slow_reasons: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "because", "evidence", "suggestion"],
        properties: {
          title: { type: "string" },
          because: { type: "string" },
          evidence: {
            type: "array",
            items: { type: "string" },
            maxItems: 4,
          },
          suggestion: { type: "string" },
        },
      },
    },
    token_reasons: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "because", "evidence", "suggestion"],
        properties: {
          title: { type: "string" },
          because: { type: "string" },
          evidence: {
            type: "array",
            items: { type: "string" },
            maxItems: 4,
          },
          suggestion: { type: "string" },
        },
      },
    },
    prompt_problems: {
      type: "array",
      items: { type: "string" },
      maxItems: 6,
    },
    better_prompt: { type: "string" },
    expected_savings: {
      type: "array",
      items: { type: "string" },
      maxItems: 6,
    },
    evidence: {
      type: "array",
      items: { type: "string" },
      maxItems: 8,
    },
  },
};

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".m",
  ".md",
  ".mm",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function defaultLogger() {}

function ensureAdvisorSchema(paths) {
  if (!fs.existsSync(paths.advisorSchemaPath)) {
    writeJson(paths.advisorSchemaPath, ADVISOR_SCHEMA);
  }
  return paths.advisorSchemaPath;
}

export function readAdvisorCache(paths, turnId) {
  return readJson(path.join(paths.advisorCacheDir, `${turnId}.json`), null);
}

function writeAdvisorCache(paths, turnId, payload) {
  writeJson(path.join(paths.advisorCacheDir, `${turnId}.json`), payload);
}

function promptMentionedFiles(promptText) {
  const regex = /(?:\/[^\s'"]+|(?:\.{1,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9_-]+)?|\b[A-Za-z0-9._-]+\.(?:dart|ts|tsx|js|jsx|py|json|md|swift|kt|java|go|rs|toml|yaml|yml|xml|css|scss|html)\b)/g;
  return unique((String(promptText || "").match(regex) || []).map((item) => item.trim()));
}

function selectTimelineItems(turn) {
  const importantTypes = new Set([
    "task_started",
    "task_complete",
    "turn_aborted",
    "user_message",
    "tool_call",
    "tool_output",
    "token_count",
    "assistant_message",
  ]);

  const items = [];
  for (const item of turn.timeline || []) {
    if (!importantTypes.has(item.type)) {
      continue;
    }
    if (item.type === "assistant_message" && item.content && String(item.content).length > 600) {
      continue;
    }
    const content =
      typeof item.content === "string"
        ? item.content
        : item.summary || JSON.stringify(item.content || {});
    items.push({
      type: item.type,
      timestamp: item.timestamp,
      callId: item.callId,
      content: truncate(normalizeWhitespace(content), 320),
    });
  }

  const failedToolIds = new Set(
    (turn.toolCalls || [])
      .filter((toolCall) => toolCall.success === false)
      .map((toolCall) => toolCall.callId),
  );

  const prioritized = items.filter((item) =>
    item.type === "user_message" ||
    item.type === "task_started" ||
    item.type === "task_complete" ||
    (item.type === "tool_output" && failedToolIds.has(item.callId)),
  );
  const merged = [...prioritized, ...items].slice(0, 24);
  return merged.map((item) => ({
    type: item.type,
    timestamp: item.timestamp,
    content: item.content,
  }));
}

function parseLineHints(command, filePath) {
  const hints = [];
  const basename = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sedRegex = new RegExp(`sed\\s+-n\\s+'?(\\d+),(\\d+)p'?\\s+.*${basename}`);
  const match = String(command || "").match(sedRegex);
  if (match) {
    hints.push({
      startLine: Number(match[1]),
      endLine: Number(match[2]),
    });
  }
  return hints;
}

function collectFileCandidates(turn) {
  const candidates = [];
  const pushCandidate = (filePath, reason, score) => {
    if (!filePath) {
      return;
    }
    candidates.push({ filePath, reason, score });
  };

  for (const filePath of turn.diagnosis?.executionSummary?.uniqueEditedFiles || []) {
    pushCandidate(filePath, "本次被修改的文件", 100);
  }
  for (const item of turn.diagnosis?.contextExpansion?.repeatedFiles || []) {
    pushCandidate(item.filePath, `被重复读取 ${item.count} 次`, 90);
  }
  for (const item of turn.diagnosis?.contextExpansion?.biggestFiles || []) {
    pushCandidate(item.filePath, `高体积文件 ${item.size} 字节`, 70);
  }
  for (const mention of promptMentionedFiles(turn.promptText)) {
    const resolved = path.isAbsolute(mention)
      ? mention
      : turn.cwd
        ? path.resolve(turn.cwd, mention)
        : mention;
    pushCandidate(resolved, "提问里直接提到的文件", 95);
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.filePath);
    if (!existing || existing.score < candidate.score) {
      deduped.set(candidate.filePath, candidate);
    }
  }
  return [...deduped.values()]
    .filter((item) => fs.existsSync(item.filePath))
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);
}

function readFileSnippet(filePath, turn) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) {
    return null;
  }

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!content || content.includes("\u0000")) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const hints = [];
  for (const toolCall of turn.diagnosis?.toolSummary?.toolCalls || []) {
    hints.push(...parseLineHints(toolCall.command || toolCall.argumentsText, filePath));
  }

  const sections = [];
  const headLines = lines.slice(0, 80).join("\n");
  sections.push({
    label: "文件开头",
    text: truncate(headLines, 2000),
  });

  for (const hint of hints.slice(0, 2)) {
    const start = Math.max(0, hint.startLine - 8);
    const end = Math.min(lines.length, hint.endLine + 8);
    const windowText = lines.slice(start, end).join("\n");
    sections.push({
      label: `命中片段 第 ${hint.startLine}-${hint.endLine} 行附近`,
      text: truncate(windowText, 1600),
    });
  }

  return {
    filePath,
    size: content.length,
    sections,
  };
}

function buildSnippetBundle(turn) {
  const snippets = [];
  let totalChars = 0;
  for (const candidate of collectFileCandidates(turn)) {
    const snippet = readFileSnippet(candidate.filePath, turn);
    if (!snippet) {
      continue;
    }
    const sections = [];
    for (const section of snippet.sections) {
      if (totalChars >= 12000) {
        break;
      }
      const allowed = Math.min(section.text.length, 3200, 12000 - totalChars);
      if (allowed <= 0) {
        break;
      }
      const trimmed = section.text.slice(0, allowed);
      totalChars += trimmed.length;
      sections.push({
        label: section.label,
        text: trimmed,
      });
    }
    if (sections.length === 0) {
      continue;
    }
    snippets.push({
      filePath: candidate.filePath,
      reason: candidate.reason,
      size: snippet.size,
      sections,
    });
    if (totalChars >= 12000) {
      break;
    }
  }
  return snippets;
}

function buildAdvisorPayload(turn) {
  const tokenSummary = turn.diagnosis?.tokenSummary?.effective || {};
  const executionSummary = turn.diagnosis?.executionSummary || {};
  const toolCalls = (turn.diagnosis?.toolSummary?.toolCalls || []).map((toolCall) => ({
    category: toolCall.category,
    name: toolCall.name,
    durationMs: toolCall.durationMs,
    success: toolCall.success !== false,
    command: truncate(toolCall.command || toolCall.argumentsText || "", 240),
    outputSnippet: truncate(toolCall.outputSnippet || "", 240),
    readFiles: (toolCall.readFiles || []).slice(0, 4),
    editedFiles: (toolCall.editedFiles || []).slice(0, 4),
  }));

  const modelSteps = (executionSummary.modelSteps || []).map((step) => ({
    title: step.title,
    durationMs: step.durationMs,
    inputTokens: step.inputTokens,
    outputTokens: step.outputTokens,
    reasoningTokens: step.reasoningTokens,
    cachedTokens: step.cachedTokens,
    model: step.model,
  }));

  return {
    turn: {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      cwd: turn.cwd,
      model: turn.model,
      startedAt: turn.startedAt,
      durationMs: turn.durationMs,
      promptText: turn.promptText || "",
      answerPreview: truncate(
        (turn.assistantMessages || [])
          .map((message) => message.text || "")
          .filter(Boolean)
          .join("\n\n"),
        1200,
      ),
    },
    diagnosis: {
      score: turn.diagnosis?.score,
      topIssues: turn.diagnosis?.topIssues || [],
      promptSummary: turn.diagnosis?.promptSummary || {},
      contextExpansion: turn.diagnosis?.contextExpansion || {},
      environmentSummary: {
        score: turn.diagnosis?.environmentSummary?.score,
        heavyCommands: (turn.diagnosis?.environmentSummary?.heavyCommands || []).map((item) => ({
          command: truncate(item.command || "", 160),
          durationMs: item.durationMs,
        })),
      },
      fixLoopSummary: turn.diagnosis?.fixLoopSummary || {},
      modelSummary: turn.diagnosis?.modelSummary || {},
      tokenSummary,
    },
    execution: {
      toolCalls: toolCalls.slice(0, 18),
      modelSteps: modelSteps.slice(0, 8),
      totalSteps: executionSummary.orderedSteps?.length || 0,
    },
    timeline: selectTimelineItems(turn),
    fileSnippets: buildSnippetBundle(turn),
  };
}

function buildAdvisorPrompt(payload) {
  return [
    "你是 codex-meter 的 AI 复盘分析器。",
    "你的任务是根据一次 Codex 单次问答的本地证据，复盘为什么这次慢、为什么 token 高，并给出更优的提问方式。",
    "",
    "严格要求：",
    "1. 只根据提供的数据下结论，不要编造不存在的原因。",
    "2. 输出必须是中文。",
    "3. 输出必须严格符合 JSON Schema，不要输出 Markdown、不要加代码块。",
    "4. 如果证据不足，要直接写“无法确认”，不要假设。",
    "5. better_prompt 必须是一段可以直接复制使用的完整提示词。",
    "6. 要明确指出：哪一句需求表达扩大了搜索范围、哪些文件/命令/步骤导致了成本上升、哪些 token 是本可以避免的。",
    "7. 禁止调用工具、禁止搜索项目、禁止请求额外信息；你只能分析下面给出的材料。",
    "",
    "你要回答的核心问题：",
    "- 这次真正慢在哪里？",
    "- 这次 token 主要浪费在哪里？",
    "- 原始 prompt 的具体问题是什么？",
    "- 如果重来一次，该怎么写提示词，才能明显减少时间消耗和 token 消耗？",
    "",
    "以下是本次问答的结构化材料：",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function runCodexAdvisor(prompt, schemaPath, cwd, logger = defaultLogger) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(
      os.tmpdir(),
      `codex-meter-advisor-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s",
      "read-only",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--color",
      "never",
      "-C",
      cwd,
      "-",
    ];
    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      logger("advisor codex timeout after 300000ms");
      child.kill("SIGTERM");
      reject(new Error("AI 复盘生成超时，请稍后重试。"));
    }, 300000);
    logger(`advisor codex spawn cwd=${JSON.stringify(cwd)} output=${JSON.stringify(outputPath)}`);
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logger(`advisor codex stderr ${JSON.stringify(text.trim())}`);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      logger(`advisor codex process error message=${JSON.stringify(error.message || "unknown")}`);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      logger(`advisor codex close code=${code}`);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Codex 复盘调用失败，退出码 ${code}`));
        return;
      }
      try {
        const content = fs.readFileSync(outputPath, "utf8");
        const parsed = JSON.parse(content);
        fs.rmSync(outputPath, { force: true });
        logger(`advisor codex parsed output bytes=${content.length}`);
        resolve(parsed);
      } catch (error) {
        logger(`advisor codex parse error message=${JSON.stringify(error.message || "unknown")}`);
        reject(new Error(`无法解析 Codex 复盘结果：${error.message}`));
      }
    });
    child.stdin.end(prompt, "utf8");
  });
}

function normalizeAdvisorResult(result) {
  const normalizeReasons = (items) =>
    Array.isArray(items)
      ? items.map((item) => ({
        title: String(item?.title || "未命名原因"),
        because: String(item?.because || "无法确认"),
        evidence: Array.isArray(item?.evidence) ? item.evidence.map(String) : [],
        suggestion: String(item?.suggestion || "暂无建议"),
      }))
      : [];

  return {
    summary: String(result?.summary || "暂无复盘结论"),
    slow_reasons: normalizeReasons(result?.slow_reasons),
    token_reasons: normalizeReasons(result?.token_reasons),
    prompt_problems: Array.isArray(result?.prompt_problems) ? result.prompt_problems.map(String) : [],
    better_prompt: String(result?.better_prompt || ""),
    expected_savings: Array.isArray(result?.expected_savings) ? result.expected_savings.map(String) : [],
    evidence: Array.isArray(result?.evidence) ? result.evidence.map(String) : [],
  };
}

export async function generateAdvisor(paths, turnId, logger = defaultLogger) {
  const turnPath = path.join(paths.turnCacheDir, `${turnId}.json`);
  const turn = readJson(turnPath, null);
  if (!turn) {
    const error = new Error("未找到对应的问答缓存，请先运行 init 或 update。");
    error.statusCode = 404;
    throw error;
  }

  const payload = buildAdvisorPayload(turn);
  logger(`advisor payload built turn=${turnId} timeline=${payload.timeline.length} snippets=${payload.fileSnippets.length}`);
  const prompt = buildAdvisorPrompt(payload);
  logger(`advisor prompt length turn=${turnId} chars=${prompt.length}`);
  const schemaPath = ensureAdvisorSchema(paths);
  const cwd = turn.cwd && fs.existsSync(turn.cwd) ? turn.cwd : paths.projectRoot;
  const rawResult = await runCodexAdvisor(prompt, schemaPath, cwd, logger);
  const advisor = normalizeAdvisorResult(rawResult);
  const cached = {
    turnId,
    generatedAt: new Date().toISOString(),
    sourceTurnStartedAt: turn.startedAt || null,
    advisor,
  };
  writeAdvisorCache(paths, turnId, cached);
  logger(`advisor cache written turn=${turnId}`);
  return cached;
}
