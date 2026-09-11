import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("web API request helpers", () => {
	it("builds PATCH JSON requests for resource updates", async () => {
		vi.stubGlobal("sessionStorage", {
			getItem: vi.fn(() => null),
			setItem: vi.fn(),
		});
		vi.stubGlobal("window", {
			location: { hash: "", pathname: "/", search: "" },
		});

		const { jsonBody } = await import("../web/src/api.ts");
		const request = jsonBody({ collectionIds: ["col-1"], namespace: "research" }, "PATCH");

		expect(request).toEqual({
			method: "PATCH",
			body: JSON.stringify({ collectionIds: ["col-1"], namespace: "research" }),
		});
	});
});
