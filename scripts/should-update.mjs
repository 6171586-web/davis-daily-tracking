import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = JSON.parse(
  await fs.readFile(path.join(root, "data", "state.json"), "utf8")
);
const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23"
}).formatToParts(new Date());
const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
const today = `${values.year}-${values.month}-${values.day}`;
const hour = Number(values.hour);
const workdays = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

if (!workdays.has(values.weekday) || hour < 9 || hour > 23) {
  console.log(
    `Outside Beijing workday check window: ${today} ${values.weekday} ${values.hour}:00`
  );
  process.exit(1);
}

if (state.lastSuccessfulCheckDate === today) {
  console.log("Today's complete valuation has already been published");
  process.exit(1);
}

console.log("Today's complete valuation has not been published yet");
