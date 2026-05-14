import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDir, hashFile, readJson, statSafe, VERSION, writeJson } from "./utils.js";

export function getPaths(projectRoot) {
  const codexHome = path.join(os.homedir(), ".codex");
  const outputRoot = path.join(projectRoot, ".codex", "codex-meter");
  const cacheRoot = path.join(outputRoot, "cache");
  const siteRoot = path.join(outputRoot, "site");
  const runtimeRoot = path.join(outputRoot, "runtime");
  const logRoot = path.join(outputRoot, "logs");
  return {
    projectRoot,
    codexHome,
    archivedSessionsDir: path.join(codexHome, "archived_sessions"),
    sessionIndexPath: path.join(codexHome, "session_index.jsonl"),
    logsDbPath: path.join(codexHome, "logs_2.sqlite"),
    outputRoot,
    cacheRoot,
    conversationCacheDir: path.join(cacheRoot, "conversations"),
    turnCacheDir: path.join(cacheRoot, "turns"),
    advisorCacheDir: path.join(cacheRoot, "advisor"),
    advisorSchemaPath: path.join(cacheRoot, "advisor.schema.json"),
    siteRoot,
    siteConversationDir: path.join(siteRoot, "conversations"),
    siteTurnDir: path.join(siteRoot, "turns"),
    runtimeRoot,
    serverStatePath: path.join(runtimeRoot, "server.json"),
    logRoot,
    serverLogPath: path.join(logRoot, "server.log"),
    indexPath: path.join(cacheRoot, "index.json"),
    configPath: path.join(outputRoot, "config.json"),
  };
}

export function ensureOutputLayout(paths) {
  for (const dirPath of [
    paths.outputRoot,
    paths.cacheRoot,
    paths.conversationCacheDir,
    paths.turnCacheDir,
    paths.advisorCacheDir,
    paths.siteRoot,
    paths.siteConversationDir,
    paths.siteTurnDir,
    paths.runtimeRoot,
    paths.logRoot,
  ]) {
    ensureDir(dirPath);
  }
}

export function loadIndex(paths) {
  return (
    readJson(paths.indexPath, null) || {
      version: VERSION,
      files: {},
      conversationFiles: {},
      lastOtelLogId: 0,
      updatedAt: null,
    }
  );
}

export function saveIndex(paths, index) {
  writeJson(paths.indexPath, {
    ...index,
    version: VERSION,
    updatedAt: new Date().toISOString(),
  });
}

export function initializeConfig(paths) {
  if (fs.existsSync(paths.configPath)) {
    return readJson(paths.configPath, {});
  }
  const config = {
    version: VERSION,
    createdAt: new Date().toISOString(),
    codexHome: paths.codexHome,
    archivedSessionsDir: paths.archivedSessionsDir,
    sessionIndexPath: paths.sessionIndexPath,
    logsDbPath: paths.logsDbPath,
    siteRoot: paths.siteRoot,
  };
  writeJson(paths.configPath, config);
  return config;
}

export function listArchivedSessionFiles(paths) {
  if (!fs.existsSync(paths.archivedSessionsDir)) {
    return [];
  }
  return fs
    .readdirSync(paths.archivedSessionsDir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => path.join(paths.archivedSessionsDir, entry))
    .sort();
}

export function detectChangedSessionFiles(paths, index, fullScan = false) {
  const files = listArchivedSessionFiles(paths);
  const changedFiles = [];
  const removedFiles = [];
  const nextFileIndex = {};

  for (const filePath of files) {
    const stats = statSafe(filePath);
    if (!stats) {
      continue;
    }
    const signature = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
    const previous = index.files[filePath];
    const hasChanged =
      fullScan ||
      !previous ||
      previous.mtimeMs !== signature.mtimeMs ||
      previous.size !== signature.size;
    nextFileIndex[filePath] = {
      ...previous,
      ...signature,
    };
    if (hasChanged) {
      changedFiles.push(filePath);
    }
  }

  for (const filePath of Object.keys(index.files)) {
    if (!nextFileIndex[filePath]) {
      removedFiles.push(filePath);
    }
  }

  return {
    files,
    changedFiles,
    removedFiles,
    nextFileIndex,
  };
}

export function finalizeFileSignature(filePath) {
  const stats = statSafe(filePath);
  if (!stats) {
    return null;
  }
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    sha1: hashFile(filePath),
  };
}
