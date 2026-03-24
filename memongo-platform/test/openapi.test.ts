import { describe, expect, it } from "vitest";
import { openApiSpec } from "../apps/api/src/openapi-spec.js";

describe("OpenAPI spec", () => {
  it("exposes core v1 routes", () => {
    expect(openApiSpec.paths["/v1/search"]).toBeDefined();
    expect(openApiSpec.paths["/v1/search-kb"]).toBeDefined();
    expect(openApiSpec.paths["/v1/profile"]).toBeDefined();
    expect(openApiSpec.paths["/openapi.json"]).toBeDefined();
    expect(openApiSpec.paths["/v1/admin/relevance/explain"]).toBeDefined();
  });

  it("defines ApiError schema", () => {
    expect(openApiSpec.components?.schemas?.ApiError).toBeDefined();
  });
});
