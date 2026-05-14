import { spawn } from "node:child_process";

import { extractBalancedSegment, parseJsonMaybe, parseTimestamp } from "./utils.js";

function extractSimpleField(body, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}=("[^"]*"|[^ ]+)`);
  const match = body.match(regex);
  if (!match) {
    return null;
  }
  const rawValue = match[1];
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

function parseBody(body) {
  const eventName = extractSimpleField(body, "event.name");
  if (!eventName) {
    return null;
  }
  const parsed = {
    eventName,
    eventKind: extractSimpleField(body, "event.kind"),
    conversationId: extractSimpleField(body, "conversation.id"),
    turnId: extractSimpleField(body, "turn.id"),
    durationMs: numberOrNull(extractSimpleField(body, "duration_ms")),
    model: extractSimpleField(body, "model"),
    timestamp: parseTimestamp(extractSimpleField(body, "event.timestamp")),
    toolName: extractSimpleField(body, "tool_name"),
    callId: extractSimpleField(body, "call_id"),
    success: booleanOrNull(extractSimpleField(body, "success")),
    isError: booleanOrNull(extractSimpleField(body, "is_error")),
    aborted: booleanOrNull(extractSimpleField(body, "aborted")),
    exitCode: numberOrNull(extractSimpleField(body, "exit_code")),
    statusCode: numberOrNull(extractSimpleField(body, "http.response.status_code")),
    endpoint: extractSimpleField(body, "endpoint"),
    promptLength: numberOrNull(extractSimpleField(body, "prompt_length")),
    inputTokenCount: numberOrNull(extractSimpleField(body, "input_token_count")),
    outputTokenCount: numberOrNull(extractSimpleField(body, "output_token_count")),
    cachedTokenCount: numberOrNull(extractSimpleField(body, "cached_token_count")),
    reasoningTokenCount: numberOrNull(extractSimpleField(body, "reasoning_token_count")),
    toolTokenCount: numberOrNull(extractSimpleField(body, "tool_token_count")),
    raw: body,
  };

  const argumentsText = extractBalancedSegment(body, "arguments=");
  if (argumentsText) {
    parsed.argumentsText = argumentsText;
    parsed.argumentsJson = parseJsonMaybe(argumentsText);
  }
  const outputText = extractBalancedSegment(body, "output=");
  if (outputText) {
    parsed.outputText = outputText;
    parsed.outputJson = parseJsonMaybe(outputText);
  }
  return parsed;
}

function numberOrNull(value) {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  if (value == null) {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

export function loadOtelRows(logsDbPath, fromId = 0) {
  return new Promise((resolve, reject) => {
    const python = `
import json
import sqlite3
import sys

db_path = sys.argv[1]
from_id = int(sys.argv[2])
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()
for row in cur.execute(
    "select id, ts, feedback_log_body from logs where target='codex_otel.log_only' and id > ? order by id",
    (from_id,)
):
    body = row["feedback_log_body"] or ""
    if "event.name=\\"codex.api_request\\"" not in body and "event.name=\\"codex.tool_result\\"" not in body and "event.name=\\"codex.sse_event\\"" not in body and "event.name=\\"codex.user_prompt\\"" not in body:
        continue
    print(json.dumps({"id": row["id"], "ts": row["ts"], "body": body}, ensure_ascii=False))
`;

    const child = spawn("python3", ["-c", python, logsDbPath, String(fromId)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rows = [];
    let stdoutBuffer = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const row = JSON.parse(line);
          const parsed = parseBody(row.body);
          if (!parsed) {
            continue;
          }
          rows.push({
            id: row.id,
            ts: row.ts,
            ...parsed,
          });
        } catch {
          continue;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        try {
          const row = JSON.parse(stdoutBuffer);
          const parsed = parseBody(row.body);
          if (parsed) {
            rows.push({
              id: row.id,
              ts: row.ts,
              ...parsed,
            });
          }
        } catch {
          // Ignore trailing partial lines.
        }
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || "Failed to load OTel logs."));
        return;
      }
      resolve(rows);
    });
  });
}
