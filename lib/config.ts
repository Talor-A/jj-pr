import { join } from "node:path";

export const TEST_JJ_CONFIG = join(import.meta.dirname, "../config.test.toml");
export const PROD_JJ_CONFIG = join(import.meta.dirname, "../config.toml");
