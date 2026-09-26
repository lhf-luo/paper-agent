import type { LiteratureProvider } from "../domain/literature-types.ts";
import {
	LiteratureProviderHttpError,
	literatureProviderDefinitions,
	type ProviderCredentials,
	searchProviderPage,
} from "../infrastructure/literature-providers.ts";

export type ProviderProbeStatus =
	| "results"
	| "empty"
	| "partial"
	| "missing-key"
	| "auth"
	| "rate-limited"
	| "network"
	| "invalid-response";

export interface ProviderProbeResult {
	providerId: LiteratureProvider;
	status: ProviderProbeStatus;
	credentialMode: "configured" | "anonymous" | "not-applicable" | "missing-required";
	checkedAt: string;
	latencyMs: number;
	recordCount: number;
	sampleTitle?: string;
	httpStatus?: number;
	message: string;
}

const PROBE_TIMEOUT_MS = 45_000;

function failureStatus(
	error: unknown,
	aborted: boolean,
): { status: ProviderProbeStatus; httpStatus?: number; message: string } {
	const httpStatus =
		error instanceof LiteratureProviderHttpError
			? error.statusCode
			: typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
				? error.statusCode
				: undefined;
	if (httpStatus === 401 || httpStatus === 403)
		return { status: "auth", httpStatus, message: "认证或访问权限失败，请检查 Key 和权限。" };
	if (httpStatus === 429) return { status: "rate-limited", httpStatus, message: "检索源已限流，请稍后重试。" };
	if (httpStatus === 408 || httpStatus === 504)
		return { status: "network", httpStatus, message: "请求超时或网络连接失败。" };
	const detail = error instanceof Error ? error.message : "";
	if (
		aborted ||
		/abort|timed?\s*out|network|fetch failed|terminated|socket hang up|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(
			detail,
		)
	)
		return { status: "network", httpStatus, message: "请求超时或网络连接失败。" };
	return { status: "invalid-response", httpStatus, message: "检索源响应异常，无法完成测试。" };
}

export async function probeLiteratureProvider(
	providerId: LiteratureProvider,
	credentials: ProviderCredentials,
	searcher: typeof searchProviderPage = searchProviderPage,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProviderProbeResult> {
	const definition = literatureProviderDefinitions.find((item) => item.id === providerId);
	if (!definition?.capabilities.includes("keyword-search")) throw new Error("Unsupported keyword search provider");
	const started = Date.now();
	const coreKey = credentials.coreApiKey || process.env.CORE_API_KEY;
	const semanticScholarKey = credentials.semanticScholarApiKey || process.env.S2_API_KEY;
	const exaKey = credentials.exaApiKey || process.env.EXA_API_KEY;
	const key =
		providerId === "core"
			? coreKey
			: providerId === "semanticscholar"
				? semanticScholarKey
				: providerId === "exa"
					? exaKey
					: undefined;
	const credentialMode =
		providerId === "core" && !key
			? "missing-required"
			: providerId === "core" || providerId === "semanticscholar" || providerId === "exa"
				? key
					? "configured"
					: "anonymous"
				: "not-applicable";
	const finish = (
		value: Pick<ProviderProbeResult, "status" | "recordCount" | "message"> &
			Partial<Pick<ProviderProbeResult, "httpStatus" | "sampleTitle">>,
	): ProviderProbeResult => ({
		providerId,
		credentialMode,
		checkedAt: new Date().toISOString(),
		latencyMs: Date.now() - started,
		...value,
	});
	if (credentialMode === "missing-required")
		return finish({ status: "missing-key", recordCount: 0, message: "缺少 CORE 必需的 API Key。" });

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const query =
			providerId === "acl_anthology" ? "language" : providerId === "usenix" ? "security" : "machine learning";
		const page = await Promise.race([
			searcher(providerId, {
				query,
				limit: 3,
				...(providerId === "acl_anthology" ? { filters: { yearFrom: 2024, yearTo: 2024, venues: ["acl"] } } : {}),
				signal: controller.signal,
				coreApiKey: coreKey,
				semanticScholarApiKey: semanticScholarKey,
				exaApiKey: exaKey,
				openAlexMailto: credentials.openAlexMailto,
				crossrefPoliteEmail: credentials.crossrefPoliteEmail,
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("Probe timed out"));
				}, timeoutMs);
			}),
		]);
		if (!page || !Array.isArray(page.records) || !page.records.every((record) => typeof record?.title === "string"))
			return finish({ status: "invalid-response", recordCount: 0, message: "检索源返回的数据格式异常。" });
		const recordCount = Math.min(page.records.length, 3);
		const sampleTitle = page.records[0]?.title?.slice(0, 300);
		const failures = page.failures ?? [];
		if (failures.length && !recordCount) {
			const classified = failureStatus(failures[0], false);
			return finish({ ...classified, recordCount });
		}
		return finish({
			status: failures.length ? "partial" : recordCount ? "results" : "empty",
			recordCount,
			...(sampleTitle ? { sampleTitle } : {}),
			message: failures.length
				? "返回了部分结果，但也有检索请求失败。"
				: recordCount
					? "检索成功并返回论文。"
					: "连接成功，但测试词未返回论文。",
		});
	} catch (error) {
		return finish({ ...failureStatus(error, controller.signal.aborted), recordCount: 0 });
	} finally {
		if (timer) clearTimeout(timer);
	}
}
