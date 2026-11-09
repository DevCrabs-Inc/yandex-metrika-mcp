import { spawn } from "node:child_process";

export const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

export const printErr = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

/** Reads a secret without echoing it; from a pipe when stdin is not a terminal. */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stdin.on("data", (c: Buffer) => chunks.push(c));
      stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
      stdin.on("error", reject);
    });
  }
  return new Promise((resolve) => {
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

/** Opens a local URL in the default browser; failures are ignored (the URL is printed anyway). */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is printed for manual opening.
  }
}
