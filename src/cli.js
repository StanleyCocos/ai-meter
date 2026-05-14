import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { analyzeConversation, attachOtelToConversation } from "./analyze.js";
import { loadOtelRows } from "./parse-otel.js";
import { hydrateConversationMetadata, parseSessionFile, parseSessionIndex } from "./parse-sessions.js";
import {
  detectChangedSessionFiles,
  ensureOutputLayout,
  finalizeFileSignature,
  getPaths,
  initializeConfig,
  loadIndex,
  saveIndex,
} from "./scan.js";
import { renderSite } from "./render.js";
import { openBrowser, startSiteServer } from "./server.js";
import { listJsonFiles, readJson, VERSION, writeJson } from "./utils.js";

const RELATIVE_SITE_INDEX_PATH = ".codex/codex-meter/site/index.html";

function printUsage() {
  console.log("用法：codex-meter <init|update|open|serve>");
}

function loadConversationCache(paths) {
  const conversations = new Map();
  for (const filePath of listJsonFiles(paths.conversationCacheDir)) {
    const conversation = readJson(filePath, null);
    if (conversation?.conversationId) {
      conversations.set(conversation.conversationId, conversation);
    }
  }
  return conversations;
}

function writeConversationCache(paths, conversation) {
  const conversationPath = path.join(
    paths.conversationCacheDir,
    `${conversation.conversationId}.json`,
  );
  writeJson(conversationPath, conversation);

  for (const turn of conversation.turns) {
    const turnPath = path.join(paths.turnCacheDir, `${turn.turnId}.json`);
    writeJson(turnPath, turn);
  }
}

function removeConversationCache(paths, conversationId) {
  fs.rmSync(path.join(paths.conversationCacheDir, `${conversationId}.json`), { force: true });
}

function removeTurnCache(paths, turnId) {
  fs.rmSync(path.join(paths.turnCacheDir, `${turnId}.json`), { force: true });
  fs.rmSync(path.join(paths.advisorCacheDir, `${turnId}.json`), { force: true });
}

function needsMetadataRefresh(conversation) {
  const genericNames = new Set(["vscode", "cli", "codex desktop", "unknown"]);
  return !conversation?.threadName || genericNames.has(String(conversation.threadName).toLowerCase());
}

function mergeOtelEvents(existingEvents, newEvents) {
  const deduped = new Map();
  for (const event of [...(existingEvents || []), ...(newEvents || [])]) {
    deduped.set(event.id, event);
  }
  return [...deduped.values()].sort((left, right) => left.id - right.id);
}

function collectConversationIdsWithOtelEvents(events) {
  const map = new Map();
  for (const event of events) {
    if (!event.conversationId) {
      continue;
    }
    const bucket = map.get(event.conversationId);
    if (bucket) {
      bucket.push(event);
    } else {
      map.set(event.conversationId, [event]);
    }
  }
  return map;
}

function describeMode(mode) {
  return mode === "init" ? "全量初始化" : "增量更新";
}

async function openSite(cwd, { shouldOpenBrowser = true } = {}) {
  const relativePath = RELATIVE_SITE_INDEX_PATH;
  const absolutePath = path.resolve(cwd, relativePath);
  if (!fs.existsSync(absolutePath)) {
    console.log(`未找到站点文件：${relativePath}`);
    console.log("请先运行 `codex-meter init` 或 `codex-meter update`。");
    return;
  }
  const paths = getPaths(cwd);
  ensureOutputLayout(paths);
  const state = await ensureBackgroundServer(paths, cwd);
  console.log("本地站点服务已启动。");
  console.log(`静态产物目录：${RELATIVE_SITE_INDEX_PATH}`);
  console.log(`访问地址：${state.url}`);
  console.log(`调试日志：${path.relative(cwd, paths.serverLogPath)}`);
  console.log("AI 复盘按钮现在走后台本地服务，不再依赖当前终端窗口保持开启。");
  if (shouldOpenBrowser) {
    openBrowser(state.url);
  }
}

function createServerLogger(logPath) {
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(logPath, line, "utf8");
  };
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadServerState(paths) {
  return readJson(paths.serverStatePath, null);
}

function stopPreviousServerIfNeeded(paths) {
  const state = loadServerState(paths);
  if (!state?.pid || !isProcessAlive(state.pid)) {
    return;
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    return;
  }
}

async function waitForServerState(paths, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = loadServerState(paths);
    if (state?.url && state?.pid && isProcessAlive(state.pid)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const logSnippet = fs.existsSync(paths.serverLogPath)
    ? fs.readFileSync(paths.serverLogPath, "utf8").split(/\r?\n/).slice(-12).join("\n")
    : "还没有生成日志。";
  throw new Error(`本地服务启动超时。\n最近日志：\n${logSnippet}`);
}

async function ensureBackgroundServer(paths, cwd) {
  stopPreviousServerIfNeeded(paths);
  fs.rmSync(paths.serverStatePath, { force: true });
  fs.appendFileSync(
    paths.serverLogPath,
    `\n[${new Date().toISOString()}] launching background server\n`,
    "utf8",
  );

  const child = spawn(process.execPath, [path.join(cwd, "bin/codex-meter.js"), "serve"], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return waitForServerState(paths);
}

async function serveSite(cwd) {
  const paths = getPaths(cwd);
  ensureOutputLayout(paths);
  const logger = createServerLogger(paths.serverLogPath);
  logger("serve command starting");
  const { server } = await startSiteServer(paths, {
    port: 0,
    logger,
    onReady: (state) => {
      writeJson(paths.serverStatePath, {
        ...state,
        startedAt: new Date().toISOString(),
      });
    },
  });

  const shutdown = () => {
    logger("serve command shutting down");
    fs.rmSync(paths.serverStatePath, { force: true });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref?.();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await new Promise(() => {});
}

async function build(mode, cwd) {
  const projectRoot = cwd;
  const paths = getPaths(projectRoot);
  ensureOutputLayout(paths);
  initializeConfig(paths);

  const index = loadIndex(paths);
  const versionMismatch = index.version !== VERSION;
  const fullScan = mode === "init" || versionMismatch;
  const sessionIndex = parseSessionIndex(paths.sessionIndexPath);
  const existingConversations = loadConversationCache(paths);
  const scanResult = detectChangedSessionFiles(paths, index, fullScan);

  console.log(`开始${describeMode(mode)}...`);
  if (versionMismatch && mode !== "init") {
    console.log("检测到站点版本已更新，正在重新生成全部缓存和页面。");
  }
  console.log(`发现 ${scanResult.files.length} 个归档会话文件。`);

  const nextIndex = {
    version: VERSION,
    files: scanResult.nextFileIndex,
    conversationFiles: { ...(index.conversationFiles || {}) },
    lastOtelLogId: index.lastOtelLogId || 0,
  };

  const removedConversationIds = [];
  for (const removedFile of scanResult.removedFiles) {
    const conversationId = index.conversationFiles?.[removedFile];
    if (conversationId) {
      const cachedConversation = existingConversations.get(conversationId);
      for (const turn of cachedConversation?.turns || []) {
        removeTurnCache(paths, turn.turnId);
      }
      removedConversationIds.push(conversationId);
      removeConversationCache(paths, conversationId);
      existingConversations.delete(conversationId);
      delete nextIndex.conversationFiles[removedFile];
    }
    delete nextIndex.files[removedFile];
  }

  const parsedConversations = new Map();
  for (const filePath of scanResult.changedFiles) {
    const parsedConversation = parseSessionFile(filePath);
    const conversation = hydrateConversationMetadata(
      parsedConversation,
      sessionIndex.get(parsedConversation.conversationId),
    );
    if (!conversation.conversationId) {
      continue;
    }
    parsedConversations.set(conversation.conversationId, conversation);
    nextIndex.conversationFiles[filePath] = conversation.conversationId;
    nextIndex.files[filePath] = finalizeFileSignature(filePath);
  }

  const otelRows = await loadOtelRows(paths.logsDbPath, fullScan ? 0 : nextIndex.lastOtelLogId || 0);
  if (otelRows.length > 0) {
    nextIndex.lastOtelLogId = otelRows[otelRows.length - 1].id;
  }
  console.log(`已加载 ${otelRows.length} 条 Codex OTel 日志。`);
  const otelByConversation = collectConversationIdsWithOtelEvents(otelRows);

  const rebuildConversationIds = new Set([
    ...parsedConversations.keys(),
    ...otelByConversation.keys(),
  ]);

  for (const [conversationId, conversation] of existingConversations.entries()) {
    if (needsMetadataRefresh(conversation)) {
      rebuildConversationIds.add(conversationId);
    }
  }

  for (const sessionId of sessionIndex.keys()) {
    if (existingConversations.has(sessionId) && !rebuildConversationIds.has(sessionId)) {
      const cached = existingConversations.get(sessionId);
      cached.threadName = sessionIndex.get(sessionId)?.thread_name || cached.threadName;
      existingConversations.set(sessionId, cached);
    }
  }

  for (const conversationId of rebuildConversationIds) {
    const parsed = parsedConversations.get(conversationId);
    const cached = existingConversations.get(conversationId);
    const sourceConversation = parsed || cached;
    if (!sourceConversation) {
      continue;
    }
    const sessionEntry = sessionIndex.get(conversationId);
    const conversation = hydrateConversationMetadata(
      parsed ? parsed : JSON.parse(JSON.stringify(cached)),
      sessionEntry,
    );
    const mergedOtelEvents = mergeOtelEvents(
      cached?.otelEvents || [],
      otelByConversation.get(conversationId) || [],
    );
    conversation.otelEvents = mergedOtelEvents;
    attachOtelToConversation(conversation, mergedOtelEvents);
    analyzeConversation(conversation);
    writeConversationCache(paths, conversation);
    existingConversations.set(conversation.conversationId, conversation);
  }

  const allConversations = [...existingConversations.values()]
    .filter((conversation) => !removedConversationIds.includes(conversation.conversationId))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));

  renderSite(paths, allConversations);
  saveIndex(paths, nextIndex);

  console.log(`已生成 ${allConversations.length} 个对话页面。`);
  console.log(`站点入口：${RELATIVE_SITE_INDEX_PATH}`);
}

export async function runCli(argv) {
  const command = argv[2];
  if (!command || !["init", "update", "open", "serve"].includes(command)) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (command === "open") {
    await openSite(process.cwd(), { shouldOpenBrowser: true });
    return;
  }
  if (command === "serve") {
    await serveSite(process.cwd());
    return;
  }
  await build(command, process.cwd());
}
