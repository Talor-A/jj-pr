import type { z } from "zod";

export function lines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function parseJsonLines<T>(schema: z.ZodType<T>, value: string): T[] {
  return lines(value).map((line) => schema.parse(JSON.parse(line)));
}
