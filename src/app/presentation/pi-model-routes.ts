import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, grantFromBody, json, readJson } from "./web-http.ts";

export async function handlePiModelRoutes(
	app: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/pi/")) return false;
	if (request.method === "GET" && url.pathname === "/api/pi/models") {
		json(response, 200, await app.piModels.view());
		return true;
	}
	if (request.method === "POST" && url.pathname === "/api/pi/models/refresh") {
		json(response, 200, await app.piModels.view(true));
		return true;
	}
	if (request.method === "POST" && ["/api/pi/auth/prepare", "/api/pi/auth/execute"].includes(url.pathname)) {
		const body = await readJson(request);
		if (
			typeof body.providerId !== "string" ||
			!Array.isArray(body.answers) ||
			body.answers.length > 12 ||
			body.answers.some((v) => typeof v !== "string" || v.length > 16_384)
		)
			throw new ApiError(400, "Invalid provider credentials");
		const credential = await app.piModels.credential(body.providerId, body.answers);
		if (credential.type !== "api_key") {
			json(response, 200, { prompt: credential });
			return true;
		}
		const plan = app.piModels.plan(body.providerId, credential);
		if (url.pathname.endsWith("/prepare")) json(response, 200, { prepared: await app.consent.prepare(plan) });
		else {
			await app.consent.consume(grantFromBody(body), plan);
			await app.piModels.save(body.providerId, body.answers);
			json(response, 200, { saved: true });
		}
		return true;
	}
	throw new ApiError(404, "Pi model API route not found");
}
