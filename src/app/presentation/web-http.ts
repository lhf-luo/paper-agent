import type { IncomingMessage, ServerResponse } from "node:http";
import type { ScreeningStatus, SearchFilters } from "../../literature/domain/literature-types.ts";
import type { ConfirmationGrant } from "../../shared/application/operation-consent.ts";

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function json(response: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

export async function readJson(request: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new ApiError(413, "Request body exceeds the configured limit");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
		return parsed as Record<string, unknown>;
	} catch {
		throw new ApiError(400, "Request body must contain a JSON object");
	}
}

export async function readBinary(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const declaredLength = Number(request.headers["content-length"] ?? 0);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new ApiError(413, "Request body exceeds the configured limit");
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new ApiError(413, "Request body exceeds the configured limit");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

export function grantFromBody(body: Record<string, unknown>): ConfirmationGrant {
	const grant = body.grant;
	if (!grant || typeof grant !== "object" || Array.isArray(grant)) throw new ApiError(400, "grant is required");
	const value = grant as Record<string, unknown>;
	for (const key of ["operationId", "manifestFingerprint", "confirmationToken", "expiresAt"] as const) {
		if (typeof value[key] !== "string") throw new ApiError(400, `grant.${key} is required`);
	}
	return value as unknown as ConfirmationGrant;
}

export function stringArray(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new ApiError(400, "Expected an array of strings");
	}
	return value;
}

export function numberValue(value: unknown, fallback?: number): number | undefined {
	if (value === undefined || value === null || value === "") return fallback;
	const number = Number(value);
	if (!Number.isFinite(number)) throw new ApiError(400, "Expected a finite number");
	return number;
}

export function namespaceValue(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
		throw new ApiError(400, "namespace must be a safe 1-64 character identifier");
	}
	return value;
}

export function boundedStringArray(
	value: unknown,
	label: string,
	maxItems = 100,
	maxLength = 500,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length > maxItems ||
		!value.every((item) => typeof item === "string" && item.trim().length > 0 && item.trim().length <= maxLength)
	) {
		throw new ApiError(400, `${label} must contain at most ${maxItems} non-empty strings`);
	}
	return [...new Set(value.map((item) => item.trim()))];
}

export function screeningStatusValue(value: unknown): ScreeningStatus | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (!["unreviewed", "include", "exclude", "maybe"].includes(String(value))) {
		throw new ApiError(400, "screeningStatus must be unreviewed, include, exclude, or maybe");
	}
	return value as ScreeningStatus;
}

export function integerValue(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new ApiError(400, `${label} must be an integer between ${minimum} and ${maximum}`);
	}
	return parsed;
}

export function searchFilters(value: unknown): SearchFilters {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ApiError(400, "filters must be a JSON object");
	const source = value as Record<string, unknown>;
	const allowed = new Set(["yearFrom", "yearTo", "venues", "authors", "openAccess", "types"]);
	const unknown = Object.keys(source).filter((key) => !allowed.has(key));
	if (unknown.length) throw new ApiError(400, `Unsupported search filter(s): ${unknown.join(", ")}`);
	const yearFrom = integerValue(source.yearFrom, "filters.yearFrom", 1000, 9999);
	const yearTo = integerValue(source.yearTo, "filters.yearTo", 1000, 9999);
	if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
		throw new ApiError(400, "filters.yearFrom cannot be later than filters.yearTo");
	}
	if (source.openAccess !== undefined && typeof source.openAccess !== "boolean") {
		throw new ApiError(400, "filters.openAccess must be a boolean");
	}
	return {
		yearFrom,
		yearTo,
		venues: boundedStringArray(source.venues, "filters.venues", 100, 500),
		authors: boundedStringArray(source.authors, "filters.authors", 100, 500),
		openAccess: source.openAccess as boolean | undefined,
		types: boundedStringArray(source.types, "filters.types", 100, 200),
	};
}
