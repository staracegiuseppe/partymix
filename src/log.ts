export type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

const consoleSink: LogSink = (line) => console.log(line);
let sinks: LogSink[] = [consoleSink];

export function setSinks(next: LogSink[]): void {
  sinks = next;
}

export function log(level: Level, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...data });
  for (const s of sinks) {
    try { s(line); } catch { /* a broken sink must never break playback */ }
  }
}
