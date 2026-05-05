import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

export type ApiErrorBody = {
	error: {
		code: string
		message: string
	}
}

export function apiErrorJson(code: string, message: string): ApiErrorBody {
	return { error: { code, message } }
}

export function jsonError(
	c: Context,
	status: ContentfulStatusCode,
	code: string,
	message: string,
) {
	return c.json(apiErrorJson(code, message), status)
}
