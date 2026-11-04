import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RecordedMarket } from "./replay.js";

export const RECORDED_FIXTURE_PATH = fileURLToPath(new URL("../fixtures/phoenix-books.json", import.meta.url));

/** Recorded real Phoenix books (see `pnpm fixtures:record`). */
export function loadRecordedMarkets(path: string = RECORDED_FIXTURE_PATH): RecordedMarket[] {
  return JSON.parse(readFileSync(path, "utf8")) as RecordedMarket[];
}
