// Minimal leveled logger. Structured enough to grep, small enough to have no deps.
// Level via NORIQ_LOG_LEVEL (debug|info|warn|error); defaults to info.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveThreshold(): LogLevel {
  const env = process.env.NORIQ_LOG_LEVEL as LogLevel | undefined;
  return env && env in RANK ? env : 'info';
}

let threshold: LogLevel = resolveThreshold();

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < RANK[threshold]) return;
  const ts = new Date().toISOString();
  const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
