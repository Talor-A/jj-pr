import { exec as _exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import z from "zod";

export const exec = promisify(_exec);

export function execWithStdin(
  command: string,
  stdin: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        Object.assign(new Error(`Command failed: ${command}`), {
          code,
          stdout,
          stderr,
          cmd: command,
        }),
      );
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const execToSchema = async <T>(
  schema: z.Schema<T>,
  command: string,
): Promise<T> => {
  const output = await exec(command).then(mapToStdout);

  return z.parse(schema, output);
};

export function mapToStdout({ stdout }: { stdout: string }): string {
  return stdout;
}

export function combineStdoutAndStderr({
  stdout,
  stderr,
}: {
  stdout: string;
  stderr: string;
}): string {
  return `${stdout}${stderr}`;
}

export async function succeeds(command: string): Promise<boolean> {
  try {
    await exec(command);
    return true;
  } catch {
    return false;
  }
}
