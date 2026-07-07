export function lines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
