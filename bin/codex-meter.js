#!/usr/bin/env node

function isBrokenPipe(error) {
  return error?.code === "EPIPE" || error?.syscall === "write";
}

function installBrokenPipeGuards() {
  const ignoreBrokenPipe = (stream) => {
    if (!stream || typeof stream.on !== "function") {
      return;
    }
    stream.on("error", (error) => {
      if (isBrokenPipe(error)) {
        process.exit(0);
      }
      throw error;
    });
  };

  ignoreBrokenPipe(process.stdout);
  ignoreBrokenPipe(process.stderr);

  process.on("SIGPIPE", () => {
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    if (isBrokenPipe(error)) {
      process.exit(0);
    }
    throw error;
  });
}

installBrokenPipeGuards();

const { runCli } = await import("../src/cli.js");

runCli(process.argv).catch((error) => {
  if (isBrokenPipe(error)) {
    process.exit(0);
    return;
  }
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
