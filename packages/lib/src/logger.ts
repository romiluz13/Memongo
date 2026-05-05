export type LogLevel =
	| "trace"
	| "debug"
	| "info"
	| "warn"
	| "error"
	| "fatal"
	| "silent"

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
	fatal: 5,
	silent: 6,
}

export type SubsystemLogger = {
	subsystem: string
	isEnabled: (level: LogLevel, target?: "any" | "console" | "file") => boolean
	trace: (message: string, meta?: Record<string, unknown>) => void
	debug: (message: string, meta?: Record<string, unknown>) => void
	info: (message: string, meta?: Record<string, unknown>) => void
	warn: (message: string, meta?: Record<string, unknown>) => void
	error: (message: string, meta?: Record<string, unknown>) => void
	fatal: (message: string, meta?: Record<string, unknown>) => void
	raw: (message: string) => void
	child: (name: string) => SubsystemLogger
}

function resolveMinLevel(): LogLevel {
	const env = process.env.MEMONGO_LOG_LEVEL?.trim().toLowerCase()
	if (env && env in LEVEL_PRIORITY) return env as LogLevel
	if (process.env.MEMONGO_DEBUG === "1" || process.env.DEBUG === "1")
		return "debug"
	return "info"
}

function shouldLog(level: LogLevel): boolean {
	const min = resolveMinLevel()
	return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[min]
}

function formatTimestamp(): string {
	const d = new Date()
	const hh = String(d.getHours()).padStart(2, "0")
	const mm = String(d.getMinutes()).padStart(2, "0")
	const ss = String(d.getSeconds()).padStart(2, "0")
	const ms = String(d.getMilliseconds()).padStart(3, "0")
	return `${hh}:${mm}:${ss}.${ms}`
}

function formatLine(
	level: LogLevel,
	subsystem: string,
	message: string,
	meta?: Record<string, unknown>,
): string {
	const ts = formatTimestamp()
	const metaStr =
		meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""
	return `${ts} [${subsystem}] ${level}: ${message}${metaStr}`
}

function writeConsoleLine(level: LogLevel, line: string) {
	if (level === "error" || level === "fatal") {
		console.error(line)
	} else if (level === "warn") {
		console.warn(line)
	} else if (level === "debug" || level === "trace") {
		console.debug(line)
	} else {
		console.log(line)
	}
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
	const emit = (
		level: LogLevel,
		message: string,
		meta?: Record<string, unknown>,
	) => {
		if (!shouldLog(level)) return
		const line = formatLine(level, subsystem, message, meta)
		writeConsoleLine(level, line)
	}

	const logger: SubsystemLogger = {
		subsystem,
		isEnabled: (level) => shouldLog(level),
		trace: (message, meta) => emit("trace", message, meta),
		debug: (message, meta) => emit("debug", message, meta),
		info: (message, meta) => emit("info", message, meta),
		warn: (message, meta) => emit("warn", message, meta),
		error: (message, meta) => emit("error", message, meta),
		fatal: (message, meta) => emit("fatal", message, meta),
		raw: (message) => {
			if (shouldLog("info")) writeConsoleLine("info", message)
		},
		child: (name) => createSubsystemLogger(`${subsystem}/${name}`),
	}
	return logger
}
