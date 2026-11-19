import { redactLog } from './runtime-logs.js';
/** Detached tasks retain an error owner; serialized queue tails do not use this. */
export function runBackground(task: Promise<unknown>, event: string): void {
  void task.catch((error) => console.error(JSON.stringify({ event, error: redactLog(error) })));
}
