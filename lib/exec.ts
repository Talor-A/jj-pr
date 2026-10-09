import {
  exec as _exec,
  type ExecOptionsWithStringEncoding,
  spawn,
} from "node:child_process";
import { promisify } from "node:util";
import z from "zod";

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  readonly code: number;
  readonly cmd: string;

  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`Command failed with exit code ${exitCode}: ${command}`, options);
    this.name = "CommandError";
    this.code = exitCode;
    this.cmd = command;
  }
}

const execAsync = promisify(_exec);

type CommandOptions = Omit<ExecOptionsWithStringEncoding, "encoding"> & {
  encoding?: BufferEncoding;
};

export async function exec(
  command: string,
  options?: CommandOptions,
): Promise<CommandOutput> {
  try {
    return await execAsync(command, { encoding: "utf8", ...options });
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    throw new CommandError(
      command,
      typeof failure.code === "number" ? failure.code : 1,
      String(failure.stdout ?? ""),
      String(failure.stderr ?? ""),
      { cause: error },
    );
  }
}

export function execWithStdin(
  command: string,
  stdin: string,
): Promise<CommandOutput> {
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
    child.on("error", (error) => {
      reject(new CommandError(command, 1, stdout, stderr, { cause: error }));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new CommandError(command, code ?? 1, stdout, stderr));
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
