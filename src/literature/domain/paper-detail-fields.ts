import type { PaperDetailField, PaperDetailFields } from "./literature-types.ts";

export const DEFAULT_PAPER_DETAIL_FIELDS = [
	{ id: "research-question", label: "研究问题" },
	{ id: "research-gap", label: "研究缺口" },
	{ id: "core-innovation", label: "核心贡献" },
	{ id: "method-design", label: "方法与系统设计" },
	{ id: "experiment-setup", label: "实验设置" },
	{ id: "key-results", label: "关键结果与证据" },
	{ id: "author-limitations", label: "局限与适用条件" },
	{ id: "reproduction-resources", label: "复现资源与条件" },
] as const;

export const PAPER_DETAIL_FIELDS_SCHEMA_VERSION = 2;

export function isCurrentPaperDetailFields(fields: PaperDetailFields | undefined): boolean {
	if (!fields || fields.schemaVersion !== PAPER_DETAIL_FIELDS_SCHEMA_VERSION) return false;
	if (!Number.isSafeInteger(fields.revision) || fields.revision < 0 || !Array.isArray(fields.entries)) return false;
	return fields.entries.every((entry) => {
		const defaultLabel = defaults.get(entry.id);
		return defaultLabel === undefined || (entry.label === defaultLabel && entry.type === "multiline");
	});
}

export interface PaperDetailFieldInput {
	id: string;
	label: string;
	type: "text" | "multiline" | "date";
	value: string;
}

const defaults = new Map<string, string>(DEFAULT_PAPER_DETAIL_FIELDS.map((field) => [field.id, field.label]));

function assertDetailFields(fields: PaperDetailFields | undefined): void {
	if (fields && !isCurrentPaperDetailFields(fields)) throw new Error("Invalid research fields");
}

export function activePaperDetailFields(previous: PaperDetailFields | undefined): PaperDetailFieldInput[] {
	assertDetailFields(previous);
	const existing = new Map(
		(previous?.entries ?? [])
			.filter((field) => !field.deletedAt)
			.map((field) => [field.id, field]),
	);
	return [
		...DEFAULT_PAPER_DETAIL_FIELDS.map((field) => ({
			id: field.id,
			label: field.label,
			type: "multiline" as const,
			value: existing.get(field.id)?.value ?? "",
		})),
		...(previous?.entries ?? [])
			.filter((field) => !field.deletedAt && !defaults.has(field.id))
			.map(({ id, label, type, value }) => ({ id, label, type, value })),
	];
}

export function validatePaperDetailFields(input: unknown): PaperDetailFieldInput[] {
	if (!Array.isArray(input)) throw new Error("Research fields must be an array");
	if (input.length > DEFAULT_PAPER_DETAIL_FIELDS.length + 30) throw new Error("Too many research fields");
	const ids = new Set<string>();
	const labels = new Set<string>();
	const fields: PaperDetailFieldInput[] = [];
	for (const item of input) {
		if (!item || typeof item !== "object") throw new Error("Invalid research field");
		const row = item as Record<string, unknown>;
		if (typeof row.id !== "string" || typeof row.label !== "string" || typeof row.value !== "string")
			throw new Error("Invalid research field");
		const id = row.id.trim();
		const label = row.label.trim();
		const type = row.type;
		if (!id || id.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
			throw new Error("Research field ID is invalid or repeated");
		if (!label || label.length > 80 || labels.has(label.toLocaleLowerCase()))
			throw new Error("Research field name is empty, too long, or repeated");
		if (
			defaults.has(id)
				? defaults.get(id) !== label || type !== "multiline"
				: !["text", "multiline", "date"].includes(String(type))
		)
			throw new Error("Research field type or default name is invalid");
		if (row.value.length > 20_000) throw new Error("Research field content is too long");
		if (
			type === "date" &&
			row.value &&
			(!/^\d{4}-\d{2}-\d{2}$/.test(row.value) ||
				Number.isNaN(Date.parse(`${row.value}T00:00:00Z`)) ||
				new Date(`${row.value}T00:00:00Z`).toISOString().slice(0, 10) !== row.value)
		)
			throw new Error("Research field date must be YYYY-MM-DD");
		ids.add(id);
		labels.add(label.toLocaleLowerCase());
		fields.push({ id, label, type: type as PaperDetailFieldInput["type"], value: row.value });
	}
	for (const field of DEFAULT_PAPER_DETAIL_FIELDS)
		if (!ids.has(field.id)) throw new Error(`Missing default research field: ${field.label}`);
	for (const [index, field] of DEFAULT_PAPER_DETAIL_FIELDS.entries())
		if (fields[index]?.id !== field.id) throw new Error("Default research field order cannot be changed");
	return fields;
}

export function updatePaperDetailFields(
	previous: PaperDetailFields | undefined,
	input: PaperDetailFieldInput[],
	now: string,
): PaperDetailFields {
	assertDetailFields(previous);
	const priorEntries = previous?.entries ?? [];
	const oldById = new Map(priorEntries.map((field) => [field.id, field]));
	const active = new Set(input.map((field) => field.id));
	const entries: PaperDetailField[] = input.map((field) => {
		const old = oldById.get(field.id);
		return old && !old.deletedAt && old.label === field.label && old.type === field.type && old.value === field.value
			? old
			: { ...field, updatedAt: now };
	});
	for (const old of priorEntries) {
		if (!defaults.has(old.id) && !active.has(old.id))
			entries.push({ ...old, deletedAt: old.deletedAt ?? now, updatedAt: old.deletedAt ? old.updatedAt : now });
	}
	return {
		schemaVersion: PAPER_DETAIL_FIELDS_SCHEMA_VERSION,
		revision: (previous?.revision ?? 0) + 1,
		updatedAt: now,
		entries,
	};
}

export function mergePaperDetailFields(
	left: PaperDetailFields | undefined,
	right: PaperDetailFields | undefined,
): PaperDetailFields | undefined {
	assertDetailFields(left);
	assertDetailFields(right);
	if (!left) return right;
	if (!right) return left;
	if (JSON.stringify(left) === JSON.stringify(right)) return left;
	const entries = new Map<string, PaperDetailField>();
	for (const field of [...left.entries, ...right.entries]) {
		const current = entries.get(field.id);
		if (
			!current ||
			field.updatedAt > current.updatedAt ||
			(field.updatedAt === current.updatedAt && field.deletedAt && !current.deletedAt)
		)
			entries.set(field.id, field);
	}
	const mergedEntries = [...entries.values()];
	if (JSON.stringify(mergedEntries) === JSON.stringify(left.entries) && left.revision >= right.revision) return left;
	if (JSON.stringify(mergedEntries) === JSON.stringify(right.entries) && right.revision >= left.revision) return right;
	return {
		schemaVersion: PAPER_DETAIL_FIELDS_SCHEMA_VERSION,
		revision:
			Math.max(left.revision, right.revision) +
			(JSON.stringify(mergedEntries) !== JSON.stringify(left.entries) &&
			JSON.stringify(mergedEntries) !== JSON.stringify(right.entries)
				? 1
				: 0),
		updatedAt: left.updatedAt > right.updatedAt ? left.updatedAt : right.updatedAt,
		entries: mergedEntries,
	};
}
