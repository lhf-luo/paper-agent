import { loadPaperAgentConfigSync } from "../../config/application/config-service.ts";
import { normalizeDoi } from "../domain/literature-identifiers.ts";
import type {
	AbstractEnrichmentProviderStatus,
	AbstractEnrichmentSummary,
	LiteratureProvider,
	PaperRecord,
} from "../domain/literature-types.ts";
import {
	enrichProviderByDoi,
	literatureProviderDefinitions,
	type ProviderDoiLookupOptions,
} from "../infrastructure/literature-providers.ts";
import { providerFailureFromError } from "../infrastructure/provider-common.ts";
import { type DoiProviderLookup, mergeMissingPaperMetadata } from "./literature-doi-enrichment.ts";

export interface AbstractEnrichmentResult {
	records: PaperRecord[];
	summary: AbstractEnrichmentSummary;
}

function lookupOptions(projectRoot: string, signal?: AbortSignal): ProviderDoiLookupOptions {
	const credentials = loadPaperAgentConfigSync(projectRoot).credentials;
	return {
		signal,
		semanticScholarApiKey: credentials?.semanticScholarApiKey,
		unpaywallEmail: credentials?.unpaywallEmail,
		openAlexMailto: credentials?.openAlexMailto,
	};
}

function providersForAbstractEnrichment(projectRoot: string): {
	providers: LiteratureProvider[];
	warnings: AbstractEnrichmentSummary["warnings"];
} {
	const definitions = new Map(literatureProviderDefinitions.map((definition) => [definition.id, definition]));
	const providers: LiteratureProvider[] = [];
	const warnings: AbstractEnrichmentSummary["warnings"] = [];
	for (const configured of loadPaperAgentConfigSync(projectRoot).search.doiEnrichmentProviders) {
		const definition = definitions.get(configured as LiteratureProvider);
		if (!definition?.lookupByDoi || !definition.capabilities.includes("abstract-enrichment")) continue;
		if (!providers.includes(definition.id)) providers.push(definition.id);
	}
	if (providers.length === 0) {
		warnings.push({ provider: "configuration", message: "No abstract-enrichment provider is configured" });
	}
	return { providers, warnings };
}

function initialProviderStatus(): AbstractEnrichmentProviderStatus {
	return { status: "healthy", attempted: 0, filled: 0, notFound: 0, failed: 0, skippedAfterCircuit: 0 };
}

function circuitStatus(error: unknown): AbstractEnrichmentProviderStatus["status"] | undefined {
	const failure = providerFailureFromError("crossref", "abstract-enrichment", error);
	if (failure.statusCode === 401 || failure.statusCode === 403) return "disabled-auth";
	if (failure.statusCode === 429) return "disabled-rate-limit";
	if (failure.statusCode === 408 || failure.statusCode === 425 || /timed?\s*out|ETIMEDOUT/i.test(failure.message)) {
		return "disabled-timeout";
	}
	if (failure.statusCode !== undefined && failure.statusCode >= 500) return "disabled-server";
	if (/network|fetch failed|socket hang up|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH/i.test(failure.message)) {
		return "disabled-network";
	}
	return undefined;
}

export async function enrichMissingAbstractsByDoi(
	records: PaperRecord[],
	projectRoot: string,
	options: { signal?: AbortSignal; concurrency?: number; lookup?: DoiProviderLookup } = {},
): Promise<AbstractEnrichmentResult> {
	const configured = providersForAbstractEnrichment(projectRoot);
	const providers = Object.fromEntries(
		configured.providers.map((provider) => [provider, initialProviderStatus()]),
	) as Partial<Record<LiteratureProvider, AbstractEnrichmentProviderStatus>>;
	const output = [...records];
	const queue: Array<{ index: number; record: PaperRecord; doi: string }> = [];
	let alreadyPresent = 0;
	let skippedWithoutDoi = 0;
	for (const [index, record] of records.entries()) {
		if (record.abstract?.trim()) {
			alreadyPresent++;
			continue;
		}
		const doi = normalizeDoi(record.identifiers.doi);
		if (!doi) {
			skippedWithoutDoi++;
			continue;
		}
		queue.push({ index, record, doi });
	}
	let filled = 0;
	let notFound = 0;
	let failed = 0;
	let next = 0;
	const warnings = [...configured.warnings];
	const lookup = options.lookup ?? enrichProviderByDoi;
	const requestOptions = lookupOptions(projectRoot, options.signal);
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, queue.length || 1));
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < queue.length) {
				if (options.signal?.aborted) throw options.signal.reason ?? new Error("Abstract enrichment aborted");
				const item = queue[next++];
				let record = item.record;
				let recordFailed = false;
				for (const provider of configured.providers) {
					const state = providers[provider]!;
					if (state.status !== "healthy") {
						state.skippedAfterCircuit++;
						continue;
					}
					state.attempted++;
					try {
						const candidate = await lookup(provider, item.doi, requestOptions);
						if (!candidate) {
							state.notFound++;
							continue;
						}
						if (normalizeDoi(candidate.identifiers.doi) !== item.doi) {
							state.failed++;
							recordFailed = true;
							warnings.push({
								recordId: record.id,
								doi: item.doi,
								provider,
								message: "Provider returned a record with a different or missing DOI",
							});
							continue;
						}
						if (!candidate.abstract?.trim()) {
							state.notFound++;
							continue;
						}
						record = mergeMissingPaperMetadata(record, candidate);
						state.filled++;
						filled++;
						break;
					} catch (error) {
						if (options.signal?.aborted) throw error;
						const failure = providerFailureFromError(provider, item.doi, error);
						if (failure.statusCode === 404) {
							state.notFound++;
							continue;
						}
						state.failed++;
						recordFailed = true;
						warnings.push({ recordId: record.id, doi: item.doi, provider, message: failure.message });
						const disabled = circuitStatus(error);
						if (disabled && state.status === "healthy") {
							state.status = disabled;
							state.message = failure.message;
							state.statusCode = failure.statusCode;
							state.retryAfter = failure.retryAfter;
						}
					}
				}
				output[item.index] = record;
				if (!record.abstract?.trim()) {
					if (recordFailed) failed++;
					else notFound++;
				}
			}
		}),
	);
	const partial =
		failed > 0 ||
		(queue.length > 0 && configured.providers.length === 0) ||
		Object.values(providers).some((provider) => provider.status !== "healthy");
	return {
		records: output,
		summary: {
			status: partial ? "partial" : "complete",
			alreadyPresent,
			attempted: queue.length,
			filled,
			notFound,
			failed,
			skippedWithoutDoi,
			providers,
			warnings,
		},
	};
}
