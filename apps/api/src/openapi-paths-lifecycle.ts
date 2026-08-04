import {
	actorRoleSchema,
	lifecycleStructuredHandleSchema,
	lifecycleProcedureHandleSchema,
	lifecycleHandleSchema,
	structuredLifecyclePatchSchema,
	procedureLifecyclePatchSchema,
	lifecycleStructuredItemSchema,
	lifecycleProcedureItemSchema,
	lifecycleItemSchema,
	lifecycleHistoryEntrySchema,
} from "./openapi-schemas.js"

export const lifecyclePaths = {
	"/v1/lifecycle/get": {
		post: {
			summary: "Fetch the current lifecycle item for a stable handle",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["handle"],
							properties: {
								handle: lifecycleHandleSchema,
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Lifecycle item",
					content: {
						"application/json": {
							schema: lifecycleItemSchema,
						},
					},
				},
				"400": { description: "Validation error" },
				"404": { description: "Not found" },
				"500": { description: "Lifecycle read failed" },
			},
		},
	},
	"/v1/lifecycle/update": {
		post: {
			summary: "Update a lifecycle item using a family-aware patch",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["handle", "patch"],
							properties: {
								handle: lifecycleHandleSchema,
								patch: {
									oneOf: [
										structuredLifecyclePatchSchema,
										procedureLifecyclePatchSchema,
									],
									description:
										"Patch shape must match the stable handle family.",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Updated lifecycle item",
					content: {
						"application/json": {
							schema: lifecycleItemSchema,
						},
					},
				},
				"400": { description: "Validation error" },
				"404": { description: "Not found" },
				"500": { description: "Lifecycle update failed" },
			},
		},
	},
	"/v1/lifecycle/delete": {
		post: {
			summary:
				"Delete a lifecycle item using invalidate-with-history semantics",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["handle"],
							properties: {
								handle: lifecycleHandleSchema,
								invalidatedBy: {
									type: "object",
									description:
										"Optional provenance describing why the item was invalidated.",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Invalidated lifecycle item",
					content: {
						"application/json": {
							schema: lifecycleItemSchema,
						},
					},
				},
				"400": { description: "Validation error" },
				"404": { description: "Not found" },
				"500": { description: "Lifecycle invalidation failed" },
			},
		},
	},
	"/v1/lifecycle/history": {
		post: {
			summary: "List lifecycle revision history for a stable handle",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["handle"],
							properties: {
								handle: lifecycleHandleSchema,
								limit: {
									type: "integer",
									minimum: 1,
									maximum: 200,
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Ordered lifecycle history",
					content: {
						"application/json": {
							schema: {
								type: "array",
								items: lifecycleHistoryEntrySchema,
							},
						},
					},
				},
				"400": { description: "Validation error" },
				"404": { description: "Not found" },
				"500": { description: "Lifecycle history failed" },
			},
		},
	},
	"/v1/procedures/outcome": {
		post: {
			summary:
				"Record a success or failure outcome on a procedure using its stable handle",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["handle", "success"],
							properties: {
								handle: lifecycleProcedureHandleSchema,
								success: { type: "boolean" },
								note: { type: "string" },
								actorRole: actorRoleSchema,
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Updated procedure lifecycle item",
					content: {
						"application/json": {
							schema: lifecycleProcedureItemSchema,
						},
					},
				},
				"400": { description: "Validation error" },
				"404": { description: "Not found" },
				"500": { description: "Procedure outcome reporting failed" },
			},
		},
	},
	"/v1/memory/feedback": {
		post: {
			summary:
				"Apply structured memory feedback using stable handles without bypassing revision history",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							oneOf: [
								{
									type: "object",
									required: ["handle", "signal"],
									properties: {
										handle: lifecycleStructuredHandleSchema,
										signal: { type: "string", enum: ["confirm"] },
										note: { type: "string" },
										actorRole: actorRoleSchema,
									},
								},
								{
									type: "object",
									required: ["handle", "signal", "patch"],
									properties: {
										handle: lifecycleStructuredHandleSchema,
										signal: { type: "string", enum: ["correct"] },
										patch: structuredLifecyclePatchSchema,
										note: { type: "string" },
										actorRole: actorRoleSchema,
									},
								},
								{
									type: "object",
									required: ["handle", "signal"],
									properties: {
										handle: lifecycleStructuredHandleSchema,
										signal: { type: "string", enum: ["irrelevant"] },
										invalidatedBy: {
											type: "object",
											description:
												"Optional provenance describing why the memory was marked irrelevant.",
										},
										note: { type: "string" },
										actorRole: actorRoleSchema,
									},
								},
							],
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Updated structured lifecycle item",
					content: {
						"application/json": {
							schema: lifecycleStructuredItemSchema,
						},
					},
				},
				"400": { description: "Validation error" },
				"404": { description: "Not found" },
				"500": { description: "Memory feedback failed" },
			},
		},
	},
} as const
