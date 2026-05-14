import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const VERSION = 5;

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function removeDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, "utf8");
}

export function listJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs
    .readdirSync(dirPath)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry));
}

export function hashFile(filePath) {
  const hash = crypto.createHash("sha1");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function safeSlug(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "unknown";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseTimestamp(value) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatDateTime(timestamp) {
  if (!timestamp) {
    return "未知";
  }
  return new Date(timestamp).toLocaleString("zh-CN", {
    hour12: false,
  });
}

export function formatDuration(durationMs) {
  if (durationMs == null || Number.isNaN(durationMs)) {
    return "未知";
  }
  if (durationMs < 1000) {
    return `${durationMs}毫秒`;
  }
  const totalSeconds = Math.round(durationMs / 100) / 10;
  if (totalSeconds < 60) {
    return `${totalSeconds}秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round((totalSeconds % 60) * 10) / 10;
  return `${minutes}分钟${seconds}秒`;
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export function truncate(value, maxLength = 220) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function unique(values) {
  return [...new Set(values)];
}

export function sumBy(values, selector) {
  return values.reduce((sum, value) => sum + (selector(value) || 0), 0);
}

export function groupBy(values, selector) {
  const groups = new Map();
  for (const value of values) {
    const key = selector(value);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(value);
    } else {
      groups.set(key, [value]);
    }
  }
  return groups;
}

export function sortBy(values, selector, direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  return [...values].sort((left, right) => {
    const leftValue = selector(left) ?? 0;
    const rightValue = selector(right) ?? 0;
    if (leftValue < rightValue) {
      return -1 * factor;
    }
    if (leftValue > rightValue) {
      return 1 * factor;
    }
    return 0;
  });
}

export function percent(part, total) {
  if (!total) {
    return 0;
  }
  return Math.round((part / total) * 1000) / 10;
}

export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function extractBalancedSegment(source, marker) {
  const startIndex = source.indexOf(marker);
  if (startIndex < 0) {
    return null;
  }
  let index = startIndex + marker.length;
  const opener = source[index];
  if (opener !== "{" && opener !== "[" && opener !== '"') {
    const nextSpace = source.indexOf(" ", index);
    return nextSpace >= 0 ? source.slice(index, nextSpace) : source.slice(index);
  }
  if (opener === '"') {
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const char = source[index];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        return source.slice(startIndex + marker.length, index + 1);
      }
      index += 1;
    }
    return null;
  }
  const stack = [opener];
  index += 1;
  let inString = false;
  let escaped = false;
  while (index < source.length && stack.length > 0) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
      if (stack.length === 0) {
        return source.slice(startIndex + marker.length, index + 1);
      }
    }
    index += 1;
  }
  return null;
}

export function parseJsonMaybe(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

export function existingFileSize(filePath) {
  const stats = statSafe(filePath);
  return stats?.isFile() ? stats.size : null;
}

export function toPosixPath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}
