import path from "node:path"

const MIME_MAP: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".json": "application/json",
	".jsonl": "application/x-ndjson",
	".jsonld": "application/ld+json",
	".pdf": "application/pdf",
	".html": "text/html",
	".htm": "text/html",
	".xhtml": "application/xhtml+xml",
	".csv": "text/csv",
	".tsv": "text/tab-separated-values",
	".xml": "application/xml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".toml": "application/toml",
	".ini": "text/plain",
	".conf": "text/plain",
	".cfg": "text/plain",
	".log": "text/plain",
	".env": "text/plain",
	".sh": "application/x-sh",
	".bash": "application/x-sh",
	".zsh": "application/x-sh",
	".bat": "application/x-bat",
	".ps1": "application/x-powershell",
	".py": "text/x-python",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".cjs": "text/javascript",
	".ts": "text/typescript",
	".tsx": "text/typescript",
	".jsx": "text/javascript",
	".css": "text/css",
	".scss": "text/x-scss",
	".less": "text/x-less",
	".sql": "application/sql",
	".graphql": "application/graphql",
	".gql": "application/graphql",
	".rs": "text/x-rust",
	".go": "text/x-go",
	".java": "text/x-java",
	".kt": "text/x-kotlin",
	".swift": "text/x-swift",
	".c": "text/x-c",
	".cpp": "text/x-c++",
	".h": "text/x-c",
	".hpp": "text/x-c++",
	".rb": "text/x-ruby",
	".php": "text/x-php",
	".lua": "text/x-lua",
	".r": "text/x-r",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".avif": "image/avif",
	".heic": "image/heic",
	".heif": "image/heif",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".flac": "audio/flac",
	".aac": "audio/aac",
	".m4a": "audio/mp4",
	".wma": "audio/x-ms-wma",
	".opus": "audio/opus",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".flv": "video/x-flv",
	".wmv": "video/x-ms-wmv",
	".zip": "application/zip",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".7z": "application/x-7z-compressed",
	".rar": "application/vnd.rar",
	".bz2": "application/x-bzip2",
	".xz": "application/x-xz",
	".wasm": "application/wasm",
	".doc": "application/msword",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

export type DetectMimeOptions = {
	buffer?: Buffer
	headerMime?: string | null
	filePath?: string
}

function normalizeMime(mime?: string | null): string | undefined {
	const cleaned = mime?.split(";")[0]?.trim().toLowerCase()
	return cleaned || undefined
}

function getFileExtension(filePath?: string): string | undefined {
	if (!filePath) {
		return undefined
	}
	try {
		if (/^https?:\/\//i.test(filePath)) {
			const url = new URL(filePath)
			return path.extname(url.pathname).toLowerCase() || undefined
		}
	} catch {
		// Fall through to plain path parsing.
	}
	const ext = path.extname(filePath).toLowerCase()
	return ext || undefined
}

function detectMimeFromPath(filePath?: string): string | undefined {
	const ext = getFileExtension(filePath)
	if (!ext) {
		return undefined
	}
	return MIME_MAP[ext] ?? "application/octet-stream"
}

function detectMimeFromOptions(opts: DetectMimeOptions): string | undefined {
	return (
		detectMimeFromPath(opts.filePath) ??
		normalizeMime(opts.headerMime) ??
		(opts.buffer ? "application/octet-stream" : undefined)
	)
}

export function detectMime(filePath: string): string
export function detectMime(opts: DetectMimeOptions): Promise<string | undefined>
export function detectMime(
	input: string | DetectMimeOptions,
): string | Promise<string | undefined> {
	if (typeof input === "string") {
		return detectMimeFromPath(input) ?? "application/octet-stream"
	}
	return Promise.resolve(detectMimeFromOptions(input))
}

export function isTextMime(mime: string): boolean {
	if (mime.startsWith("text/")) return true
	const textLike = [
		"application/json",
		"application/xml",
		"application/yaml",
		"application/toml",
		"application/sql",
		"application/graphql",
		"application/x-ndjson",
		"application/ld+json",
		"application/javascript",
		"application/x-sh",
	]
	return textLike.includes(mime)
}

export function isImageMime(mime: string): boolean {
	return mime.startsWith("image/")
}

export function isAudioMime(mime: string): boolean {
	return mime.startsWith("audio/")
}
