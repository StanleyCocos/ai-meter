import fs from "node:fs";
import path from "node:path";

import { parseTimestamp, statSafe, truncate, normalizeWhitespace } from "./utils.js";

function createConversation(filePath) {
  return {
    conversationId: null,
    threadName: null,
    updatedAt: null,
    sourceFile: filePath,
    sessionMeta: null,
    otelEvents: [],
    totalEventCount: 0,
    turns: [],
  };
}

function createTurn(turnId, conversation) {
  return {
    conversationId: conversation.conversationId,
    turnId,
    threadId: conversation.conversationId,
    cwd: null,
    currentDate: null,
    timezone: null,
    approvalPolicy: null,
    sandboxPolicy: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    timeToFirstTokenMs: null,
    collaborationMode: null,
    promptText: "",
    promptLength: 0,
    promptMessages: [],
    assistantMessages: [],
    reasoning: [],
    tokenSnapshots: [],
    toolCalls: [],
    toolCallMap: {},
    timeline: [],
    eventCount: 0,
    status: "unknown",
    model: null,
    rawTags: [],
    otel: {
      apiRequests: [],
      sseEvents: [],
      toolResults: [],
      promptEvents: [],
    },
    diagnosis: null,
  };
}

function turnArray(conversation) {
  return conversation.turns;
}

function getOrCreateTurn(conversation, turnsById, turnId, fallbackTimestamp = null) {
  const key = turnId || `unknown-${turnArray(conversation).length + 1}`;
  if (!turnsById.has(key)) {
    const turn = createTurn(key, conversation);
    if (fallbackTimestamp) {
      turn.startedAt = fallbackTimestamp;
    }
    turnsById.set(key, turn);
    conversation.turns.push(turn);
  }
  return turnsById.get(key);
}

function addTimeline(turn, item) {
  turn.timeline.push(item);
  turn.eventCount += 1;
}

function attachToolCallOutput(turn, callId, output, timestamp) {
  const toolCall = turn.toolCallMap[callId];
  if (!toolCall) {
    return;
  }
  toolCall.output = output;
  toolCall.outputSnippet = truncate(output, 400);
  addTimeline(turn, {
    type: "tool_output",
    timestamp,
    callId,
    toolName: toolCall.name,
    content: truncate(output, 1200),
  });
}

export function parseSessionIndex(sessionIndexPath) {
  const index = new Map();
  if (!fs.existsSync(sessionIndexPath)) {
    return index;
  }
  const content = fs.readFileSync(sessionIndexPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const value = JSON.parse(line);
      index.set(value.id, value);
    } catch {
      continue;
    }
  }
  return index;
}

export function parseSessionFile(filePath) {
  const conversation = createConversation(filePath);
  const turnsById = new Map();
  const toolToTurnId = new Map();
  let activeTurnId = null;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = parseTimestamp(event.timestamp);
    conversation.totalEventCount += 1;
    const payload = event.payload || {};

    if (event.type === "session_meta") {
      conversation.conversationId = payload.id || conversation.conversationId;
      conversation.sessionMeta = payload;
      continue;
    }

    if (event.type === "turn_context") {
      const turn = getOrCreateTurn(conversation, turnsById, payload.turn_id, timestamp);
      turn.cwd = payload.cwd || turn.cwd;
      turn.currentDate = payload.current_date || turn.currentDate;
      turn.timezone = payload.timezone || turn.timezone;
      turn.approvalPolicy = payload.approval_policy || turn.approvalPolicy;
      turn.sandboxPolicy = payload.sandbox_policy || turn.sandboxPolicy;
      activeTurnId = turn.turnId;
      addTimeline(turn, {
        type: "turn_context",
        timestamp,
        summary: "已加载回合上下文",
      });
      continue;
    }

    if (event.type === "event_msg" && payload.type === "task_started") {
      const turn = getOrCreateTurn(conversation, turnsById, payload.turn_id, timestamp);
      turn.startedAt = turn.startedAt || timestamp;
      turn.collaborationMode = payload.collaboration_mode_kind || turn.collaborationMode;
      activeTurnId = turn.turnId;
      addTimeline(turn, {
        type: "task_started",
        timestamp,
        summary: "任务开始",
      });
      continue;
    }

    if (event.type === "event_msg" && payload.type === "task_complete") {
      const turn = getOrCreateTurn(conversation, turnsById, payload.turn_id || activeTurnId, timestamp);
      turn.completedAt = timestamp;
      turn.durationMs = payload.duration_ms ?? turn.durationMs;
      turn.timeToFirstTokenMs = payload.time_to_first_token_ms ?? turn.timeToFirstTokenMs;
      turn.status = "completed";
      addTimeline(turn, {
        type: "task_complete",
        timestamp,
        summary: "任务完成",
      });
      continue;
    }

    if (event.type === "event_msg" && payload.type === "turn_aborted") {
      const turn = getOrCreateTurn(conversation, turnsById, activeTurnId, timestamp);
      turn.status = "aborted";
      addTimeline(turn, {
        type: "turn_aborted",
        timestamp,
        summary: "回合中断",
      });
      continue;
    }

    if (event.type === "event_msg" && payload.type === "user_message") {
      const turn = getOrCreateTurn(conversation, turnsById, activeTurnId, timestamp);
      const message = payload.message || "";
      turn.promptMessages.push(message);
      turn.promptText = turn.promptMessages.join("\n\n");
      turn.promptLength = turn.promptText.length;
      addTimeline(turn, {
        type: "user_message",
        timestamp,
        content: message,
      });
      continue;
    }

    if (event.type === "event_msg" && payload.type === "agent_message") {
      const turn = getOrCreateTurn(conversation, turnsById, activeTurnId, timestamp);
      const message = payload.message || "";
      turn.assistantMessages.push({
        timestamp,
        phase: payload.phase || "unknown",
        text: message,
      });
      addTimeline(turn, {
        type: "assistant_message",
        timestamp,
        phase: payload.phase || "unknown",
        content: message,
      });
      continue;
    }

    if (event.type === "event_msg" && payload.type === "token_count") {
      const turn = getOrCreateTurn(conversation, turnsById, activeTurnId, timestamp);
      turn.tokenSnapshots.push({
        timestamp,
        info: payload.info || null,
        rateLimits: payload.rate_limits || null,
      });
      addTimeline(turn, {
        type: "token_count",
        timestamp,
        content: payload.info,
      });
      continue;
    }

    if (event.type === "response_item" && payload.type === "reasoning") {
      const turn = getOrCreateTurn(conversation, turnsById, activeTurnId, timestamp);
      const summary = Array.isArray(payload.summary)
        ? payload.summary.map((item) => item?.text || "").join(" ")
        : "";
      turn.reasoning.push({
        timestamp,
        summary,
      });
      addTimeline(turn, {
        type: "reasoning",
        timestamp,
        content: summary || "推理事件",
      });
      continue;
    }

    if (event.type === "response_item" && payload.type === "function_call") {
      const turn = getOrCreateTurn(conversation, turnsById, activeTurnId, timestamp);
      const toolCall = {
        callId: payload.call_id,
        name: payload.name,
        argumentsText: payload.arguments || "",
        arguments: payload.arguments || "",
        output: null,
        outputSnippet: null,
        timestamp,
        source: "response_item",
      };
      turn.toolCalls.push(toolCall);
      turn.toolCallMap[payload.call_id] = toolCall;
      toolToTurnId.set(payload.call_id, turn.turnId);
      addTimeline(turn, {
        type: "tool_call",
        timestamp,
        callId: payload.call_id,
        toolName: payload.name,
        content: truncate(payload.arguments || "", 800),
      });
      continue;
    }

    if (event.type === "response_item" && payload.type === "function_call_output") {
      const turnId = toolToTurnId.get(payload.call_id) || activeTurnId;
      const turn = getOrCreateTurn(conversation, turnsById, turnId, timestamp);
      attachToolCallOutput(turn, payload.call_id, payload.output || "", timestamp);
      continue;
    }

    if (event.type === "response_item" && payload.type === "custom_tool_call") {
      const turn = getOrCreateTurn(conversation, turnsById, activeTurnId, timestamp);
      const toolCall = {
        callId: payload.call_id,
        name: payload.name,
        argumentsText: payload.input || "",
        arguments: payload.input || "",
        output: null,
        outputSnippet: null,
        timestamp,
        source: "custom_tool_call",
      };
      turn.toolCalls.push(toolCall);
      turn.toolCallMap[payload.call_id] = toolCall;
      toolToTurnId.set(payload.call_id, turn.turnId);
      addTimeline(turn, {
        type: "tool_call",
        timestamp,
        callId: payload.call_id,
        toolName: payload.name,
        content: truncate(payload.input || "", 800),
      });
      continue;
    }

    if (event.type === "response_item" && payload.type === "custom_tool_call_output") {
      const turnId = toolToTurnId.get(payload.call_id) || activeTurnId;
      const turn = getOrCreateTurn(conversation, turnsById, turnId, timestamp);
      attachToolCallOutput(turn, payload.call_id, payload.output || "", timestamp);
      continue;
    }

    if (event.type === "response_item" && payload.type === "patch_apply_end") {
      const turn = getOrCreateTurn(conversation, turnsById, activeTurnId, timestamp);
      addTimeline(turn, {
        type: "patch_apply_end",
        timestamp,
        content: payload,
      });
      continue;
    }
  }

  for (const turn of conversation.turns) {
    turn.conversationId = conversation.conversationId;
    turn.threadId = conversation.conversationId;
    if (!turn.completedAt && turn.durationMs != null && turn.startedAt != null) {
      turn.completedAt = turn.startedAt + turn.durationMs;
    }
    if (!turn.durationMs && turn.startedAt && turn.completedAt) {
      turn.durationMs = Math.max(0, turn.completedAt - turn.startedAt);
    }
    if (!turn.status || turn.status === "unknown") {
      turn.status = turn.completedAt ? "completed" : "in_progress";
    }
    turn.timeline.sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
    turn.promptText = normalizeWhitespace(turn.promptText);
    turn.promptLength = turn.promptText.length;
  }

  conversation.turns.sort((left, right) => (left.startedAt || 0) - (right.startedAt || 0));
  return conversation;
}

export function hydrateConversationMetadata(conversation, sessionIndexEntry) {
  const firstPrompt =
    conversation.turns.find((turn) => turn.promptText)?.promptText ||
    conversation.turns.find((turn) => turn.promptMessages?.length)?.promptMessages?.[0] ||
    "";
  const promptLabel = firstPrompt ? truncate(firstPrompt, 48) : null;
  const projectLabel = conversation.sessionMeta?.cwd
    ? path.basename(conversation.sessionMeta.cwd)
    : null;
  const sourceFileLabel = conversation.sourceFile ? path.basename(conversation.sourceFile, ".jsonl") : null;
  conversation.threadName =
    sessionIndexEntry?.thread_name ||
    promptLabel ||
    projectLabel ||
    sourceFileLabel ||
    conversation.conversationId;
  conversation.updatedAt =
    parseTimestamp(sessionIndexEntry?.updated_at) ||
    parseTimestamp(conversation.sessionMeta?.timestamp) ||
    statSafe(conversation.sourceFile)?.mtimeMs ||
    null;
  for (const turn of conversation.turns) {
    turn.threadName = conversation.threadName;
    turn.cwd = turn.cwd || conversation.sessionMeta?.cwd || null;
    turn.model = turn.model || conversation.sessionMeta?.model || null;
  }
  return conversation;
}
