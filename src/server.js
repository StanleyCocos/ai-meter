import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

import { generateAdvisor, readAdvisorCache } from "./advisor.js";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

export function openBrowser(url) {
  let command = null;
  let args = [];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "linux") {
    command = "xdg-open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  }

  if (!command) {
    return false;
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

function defaultLogger() {}

function resolveStaticFile(siteRoot, pathname) {
  const safePath = decodeURIComponent(pathname.split("?")[0] || "/");
  const relativePath = safePath === "/" ? "index.html" : safePath.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(siteRoot, relativePath));
  if (!filePath.startsWith(path.normalize(siteRoot + path.sep)) && filePath !== path.join(siteRoot, "index.html")) {
    return null;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return filePath;
  }
  return null;
}

async function handleAdvisorRequest(request, response, paths, turnId, inflight, logger) {
  if (request.method === "GET") {
    const cached = readAdvisorCache(paths, turnId);
    if (!cached) {
      logger(`advisor cache miss turn=${turnId}`);
      sendJson(response, 404, {
        status: "missing",
        message: "当前还没有生成 AI 复盘建议。",
      });
      return;
    }
    sendJson(response, 200, {
      status: "ready",
      data: cached,
    });
    logger(`advisor cache hit turn=${turnId}`);
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, {
      status: "error",
      message: "不支持的请求方法。",
    });
    return;
  }

  let task = inflight.get(turnId);
  if (!task) {
    logger(`advisor generation start turn=${turnId}`);
    task = generateAdvisor(paths, turnId, logger);
    inflight.set(turnId, task);
    task.finally(() => {
      if (inflight.get(turnId) === task) {
        inflight.delete(turnId);
      }
    });
  }

  try {
    const result = await task;
    logger(`advisor generation success turn=${turnId}`);
    sendJson(response, 200, {
      status: "ready",
      data: result,
    });
  } catch (error) {
    logger(`advisor generation failed turn=${turnId} message=${JSON.stringify(error.message || "unknown")}`);
    sendJson(response, error.statusCode || 500, {
      status: "error",
      message: error.message || "生成 AI 复盘建议失败。",
    });
  }
}

export function startSiteServer(paths, {
  port = 0,
  open = false,
  logger = defaultLogger,
  onReady = null,
} = {}) {
  const inflight = new Map();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      logger(`request ${request.method || "GET"} ${url.pathname}`);
      const advisorMatch = url.pathname.match(/^\/api\/turns\/([^/]+)\/advisor$/);
      if (advisorMatch) {
        await handleAdvisorRequest(request, response, paths, advisorMatch[1], inflight, logger);
        return;
      }

      if (!["GET", "HEAD"].includes(request.method || "")) {
        response.writeHead(405, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("不支持的请求方法。");
        return;
      }

      const filePath = resolveStaticFile(paths.siteRoot, url.pathname);
      if (!filePath) {
        logger(`static missing ${url.pathname}`);
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("页面不存在。");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      logger(`server error message=${JSON.stringify(error.message || "unknown")}`);
      response.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(error.message || "服务端异常。");
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      logger(`listen error message=${JSON.stringify(error.message || "unknown")}`);
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      const url = `http://127.0.0.1:${resolvedPort}`;
      logger(`server listening url=${url}`);
      if (typeof onReady === "function") {
        onReady({
          pid: process.pid,
          port: resolvedPort,
          url,
        });
      }
      if (open) {
        openBrowser(url);
      }
      resolve({
        server,
        port: resolvedPort,
        url,
      });
    });
  });
}
