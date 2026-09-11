import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256File } from "../../artifacts/application/artifact-discovery.ts";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import { normalizeArxivId, normalizeDoi, paperRecordId } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import type { DoiProviderLookup } from "./literature-doi-enrichment.ts";
import type { ExtractedPdfMetadata, PdfMetadataWarning, PreparedPdfImport } from "./literature-import-contracts.ts";
import {
	enrichImportedPdfRecord,
	type ProviderSearcher,
	recoverRequiredPdfMetadataByDoi,
} from "./literature-import-enrichment.ts";

export type {
	ExtractedPdfMetadata,
	PdfMetadataNeedsReview,
	PdfMetadataWarning,
	PreparedPdfImport,
} from "./literature-import-contracts.ts";
export { enrichImportedPdfRecord } from "./literature-import-enrichment.ts";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
}

function parsePdfInfo(stdout: string): Map<string, string> {
	const metadata = new Map<string, string>();
	for (const line of stdout.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator > 0) metadata.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
	}
	return metadata;
}

function usefulMetadataValue(value: string | undefined): string | undefined {
	const trimmed = value?.replace(/\s+/g, " ").trim();
	if (!trimmed || /^(?:untitled|unknown|none|microsoft word|document)$/i.test(trimmed)) return undefined;
	return trimmed;
}

const embeddedMetadataPlaceholderPattern =
	/^(?:cnki|ttkn|adobe(?: acrobat)?|acrobat pdfmaker|microsoft(?: word)?|scanner|scanned document|pdf)$/i;

function usefulEmbeddedMetadataValue(value: string | undefined): string | undefined {
	const useful = usefulMetadataValue(value);
	return useful && !embeddedMetadataPlaceholderPattern.test(useful) ? useful : undefined;
}

function splitMetadataAuthors(value: string | undefined): string[] {
	return (value ?? "")
		.split(/\s*(?:;|\band\b|,(?=\s*[\p{Lu}]))\s*/iu)
		.map((author) => author.trim())
		.filter((author) => Boolean(author) && !embeddedMetadataPlaceholderPattern.test(author));
}

function metadataDateYear(value: string | undefined): number | undefined {
	const match = value?.match(/\b(19\d{2}|20\d{2})\b/);
	return match ? Number(match[1]) : undefined;
}

function cleanPdfLine(value: string): string {
	return value
		.replace(/[\u0000-\u001f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isBoilerplateLine(line: string): boolean {
	return (
		!line ||
		/^https?:\/\//i.test(line) ||
		/^(?:doi|arxiv)\s*:/i.test(line) ||
		/^(?:isbn|issn)\b/i.test(line) ||
		/^\d+$/i.test(line) ||
		/^(?:abstract|introduction|keywords?|contents?)\b/i.test(line) ||
		/^this paper is included in/i.test(line) ||
		/^open access to the proceedings/i.test(line) ||
		/^copyright\b/i.test(line) ||
		/^usenix association\b/i.test(line)
	);
}

const affiliationPattern =
	/\b(?:university|institute|laboratory|lab\b|school|department|college|corporation|corp\b|inc\b|research center|centre)\b/i;

function cleanAuthorToken(value: string): string | undefined {
	const token = value
		.replace(/\([^)]*\)/g, " ")
		.replace(/[\d*∗†‡§#,，]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[,，、;；]|[,，、;；]$/g, "")
		.trim();
	if (!token || affiliationPattern.test(token) || /@|https?:/i.test(token)) return undefined;
	const compactCjkName = token.replace(/\s+/g, "");
	if (/^[\p{Script=Han}·]{2,12}$/u.test(compactCjkName)) return compactCjkName;
	const words = token.split(/\s+/).filter(Boolean);
	if (words.length < 2 || words.length > 6) return undefined;
	if (words.some((word) => !/^[\p{L}.'’-]+$/u.test(word))) return undefined;
	return token;
}

function authorsFromRawLine(raw: string): string[] {
	let line = raw.trim();
	const affiliation = affiliationPattern.exec(line);
	if (affiliation?.index !== undefined) line = line.slice(0, affiliation.index).replace(/[,;]\s*$/, "");
	if (!line || /@|https?:/i.test(line)) return [];
	const columns = line
		.split(/\s{2,}/)
		.map(cleanAuthorToken)
		.filter((value): value is string => Boolean(value));
	if (columns.length >= 2) return columns;
	const delimited = line
		.replace(/\s+and\s+/gi, ",")
		.split(/\s*[,，、;；]\s*/)
		.map(cleanAuthorToken)
		.filter((value): value is string => Boolean(value));
	return delimited.length >= 1 && /[,，、;；]|\band\b/i.test(line) ? delimited : [];
}

function isStandaloneTitleMarker(line: string): boolean {
	return /^[*†‡§#]+$/.test(line);
}

function joinTitleLines(lines: string[]): string {
	return lines.reduce((title, line) => {
		if (!title) return line;
		return /\p{Script=Han}$/u.test(title) && /^\p{Script=Han}/u.test(line) ? `${title}${line}` : `${title} ${line}`;
	}, "");
}

function extractIdentifiersAndLinks(text: string) {
	const doi = normalizeDoi(text.match(/\b10\.\d{4,9}\/[^\s<>"']+/i)?.[0]);
	const arxivId = normalizeArxivId(
		text.match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)([a-z.-]+\/\d{7}|\d{4}\.\d{4,5})/i)?.[1],
	);
	const urls = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
		.map((match) => match[0].replace(/[.,;]+$/, ""))
		.filter((value, index, values) => values.indexOf(value) === index);
	return { doi, arxivId, urls };
}

export function extractMetadataFromPdfText(
	text: string,
	fallback: { title?: string; authors?: string[]; year?: number } = {},
	source: ExtractedPdfMetadata["source"] = "text",
): ExtractedPdfMetadata {
	const rawLines = text.split(/\r?\n/).map((line) => line.trimEnd());
	const contentEnd = rawLines.findIndex((line) =>
		/^\s*(?:abstract\b|摘\s*要\s*[:：]?|1(?:\.|\s)+introduction\b)/i.test(line),
	);
	const headerLines = rawLines.slice(0, contentEnd >= 0 ? contentEnd : Math.min(rawLines.length, 80));
	let authors = fallback.authors?.filter(Boolean) ?? [];
	let authorLineIndex = -1;
	for (let index = 0; index < headerLines.length; index++) {
		const candidates = authorsFromRawLine(headerLines[index]);
		if (candidates.length === 0) continue;
		if (authors.length === 0) authors = candidates;
		authorLineIndex = index;
		break;
	}

	let title = usefulMetadataValue(fallback.title);
	if (!title && authorLineIndex > 0) {
		const candidates: string[] = [];
		for (let index = authorLineIndex - 1; index >= 0 && candidates.length < 4; index--) {
			const line = cleanPdfLine(headerLines[index]);
			if (isStandaloneTitleMarker(line)) continue;
			if (isBoilerplateLine(line)) {
				if (candidates.length) break;
				continue;
			}
			if (/\b(?:proceedings|symposium|conference|workshop)\b/i.test(line) && candidates.length) break;
			candidates.unshift(line);
		}
		title = usefulMetadataValue(joinTitleLines(candidates));
	}

	const normalizedLines = rawLines.map(cleanPdfLine);
	const normalizedText = normalizedLines.join("\n");
	const { doi, arxivId, urls } = extractIdentifiersAndLinks(normalizedText);
	const headerText = headerLines.map(cleanPdfLine).join("\n");
	const yearMatch = headerText.match(/\b(19\d{2}|20\d{2})\b/);
	const proceedingsIndex = normalizedLines.findIndex((line) =>
		/^this paper is included in the proceedings\b/i.test(line),
	);
	const proceedingsVenue =
		proceedingsIndex >= 0
			? [
					normalizedLines[proceedingsIndex].replace(/^this paper is included in the\s+/i, ""),
					normalizedLines[proceedingsIndex + 1],
				]
					.filter((line) => line && !/^\w+\s+\d{1,2}/i.test(line))
					.join(" ")
			: undefined;
	const venueLine =
		proceedingsVenue ||
		normalizedLines.find(
			(line) =>
				!/^https?:\/\//i.test(line) &&
				/\b(?:proceedings|symposium|conference|workshop)\b/i.test(line) &&
				!/^this paper is included/i.test(line),
		);
	return {
		title,
		authors,
		year: yearMatch ? Number(yearMatch[1]) : fallback.year,
		venue: usefulMetadataValue(venueLine),
		doi,
		arxivId,
		urls,
		source,
		warnings: [],
	};
}

async function runOcr(path: string, executor: CommandExecutor, signal?: AbortSignal): Promise<ExecResult> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "paper-agent-import-ocr-"));
	try {
		const prefix = join(temporaryDirectory, "page");
		const rendered = await executor.exec(
			"pdftoppm",
			["-f", "1", "-l", "1", "-r", "200", "-png", "-singlefile", path, prefix],
			{ cwd: dirname(path), signal, timeout: 90_000 },
		);
		if (rendered.code !== 0 || rendered.killed || signal?.aborted) {
			return { code: rendered.code, stdout: "", stderr: rendered.stderr, killed: rendered.killed };
		}
		const bilingual = await executor.exec("tesseract", [`${prefix}.png`, "stdout", "-l", "eng+chi_sim"], {
			cwd: temporaryDirectory,
			signal,
			timeout: 90_000,
		});
		if (bilingual.code === 0 || bilingual.killed || signal?.aborted) return bilingual;
		return executor.exec("tesseract", [`${prefix}.png`, "stdout", "-l", "eng"], {
			cwd: temporaryDirectory,
			signal,
			timeout: 90_000,
		});
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export async function preparePdfImport(
	path: string,
	executor: CommandExecutor,
	projectRoot: string,
	signal?: AbortSignal,
	options: {
		enrich?: boolean;
		searcher?: ProviderSearcher;
		doiLookup?: DoiProviderLookup;
		hints?: { doi?: string; arxivId?: string; urls?: string[] };
	} = {},
): Promise<PreparedPdfImport> {
	const warnings: PdfMetadataWarning[] = [];
	let embedded = new Map<string, string>();
	try {
		const info = await executor.exec("pdfinfo", [path], { cwd: dirname(path), signal, timeout: 30_000 });
		if (info.code === 0 && !info.killed && !signal?.aborted) embedded = parsePdfInfo(info.stdout);
		else warnings.push({ stage: "pdfinfo", message: info.stderr.trim() || "pdfinfo failed" });
	} catch (error) {
		warnings.push({ stage: "pdfinfo", message: error instanceof Error ? error.message : String(error) });
	}
	const embeddedTitle = usefulEmbeddedMetadataValue(embedded.get("title"));
	const embeddedAuthors = splitMetadataAuthors(embedded.get("author"));
	const embeddedYear = metadataDateYear(embedded.get("creationdate")) ?? metadataDateYear(embedded.get("moddate"));
	let textResult: ExecResult;
	try {
		textResult = await executor.exec("pdftotext", ["-f", "1", "-l", "2", "-layout", "-enc", "UTF-8", path, "-"], {
			cwd: dirname(path),
			signal,
			timeout: 60_000,
		});
	} catch (error) {
		textResult = { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
	let metadata = extractMetadataFromPdfText(
		textResult.code === 0 && !textResult.killed ? textResult.stdout : "",
		{ title: embeddedTitle, authors: embeddedAuthors, year: embeddedYear },
		embeddedTitle && embeddedAuthors.length ? "pdfinfo" : "text",
	);
	if (textResult.code !== 0 || textResult.killed) {
		warnings.push({ stage: "text", message: textResult.stderr.trim() || "pdftotext failed" });
	}
	if (!metadata.title || metadata.authors.length === 0) {
		try {
			const ocr = await runOcr(path, executor, signal);
			if (ocr.code === 0 && !ocr.killed) {
				const ocrMetadata = extractMetadataFromPdfText(
					ocr.stdout,
					{ title: metadata.title, authors: metadata.authors },
					"ocr",
				);
				metadata = {
					...metadata,
					title: ocrMetadata.title ?? metadata.title,
					authors: ocrMetadata.authors.length ? ocrMetadata.authors : metadata.authors,
					year: metadata.year ?? ocrMetadata.year,
					venue: metadata.venue ?? ocrMetadata.venue,
					doi: metadata.doi ?? ocrMetadata.doi,
					arxivId: metadata.arxivId ?? ocrMetadata.arxivId,
					urls: [...new Set([...metadata.urls, ...ocrMetadata.urls])],
					source: "ocr",
				};
			} else {
				warnings.push({ stage: "ocr", message: ocr.stderr.trim() || "OCR failed" });
			}
		} catch (error) {
			warnings.push({ stage: "ocr", message: error instanceof Error ? error.message : String(error) });
		}
	}
	metadata = {
		...metadata,
		doi: metadata.doi ?? normalizeDoi(options.hints?.doi),
		arxivId: metadata.arxivId ?? normalizeArxivId(options.hints?.arxivId),
		urls: [...new Set([...metadata.urls, ...(options.hints?.urls ?? [])])],
	};
	let doiRecord: PaperRecord | undefined;
	let metadataSource: PreparedPdfImport["metadataSource"] = metadata.source;
	if ((!metadata.title || metadata.authors.length === 0) && metadata.doi && options.enrich !== false) {
		const recovery = await recoverRequiredPdfMetadataByDoi(metadata.doi, projectRoot, signal, options.doiLookup);
		warnings.push(...recovery.warnings);
		doiRecord = recovery.record;
		if (doiRecord) {
			metadata = {
				...metadata,
				title: metadata.title ?? usefulMetadataValue(doiRecord.title),
				authors: metadata.authors.length ? metadata.authors : doiRecord.authors.filter(Boolean),
				year: metadata.year ?? doiRecord.year,
				venue: metadata.venue ?? doiRecord.venue,
				arxivId: metadata.arxivId ?? doiRecord.identifiers.arxivId,
			};
			metadataSource = "doi";
		}
	}
	const missingFields: Array<"title" | "authors"> = [];
	if (!metadata.title) missingFields.push("title");
	if (metadata.authors.length === 0) missingFields.push("authors");
	if (missingFields.length) {
		return {
			warnings,
			metadataSource,
			needsMetadata: {
				source: path,
				reason: "needs_metadata",
				missingFields,
				detail: `Could not extract required PDF metadata after ${metadata.source}`,
				warnings,
			},
		};
	}
	const materialHash = await sha256File(path);
	const fileUrl = new URL(`file:///${path.replaceAll("\\", "/")}`).href;
	const links: PaperRecord["links"] = [{ url: fileUrl, kind: "other" }];
	for (const url of metadata.urls) if (!links.some((link) => link.url === url)) links.push({ url, kind: "landing" });
	for (const link of doiRecord?.links ?? [])
		if (!links.some((existing) => existing.url === link.url)) links.push(link);
	if (metadata.doi && !links.some((link) => link.kind === "doi"))
		links.push({ url: `https://doi.org/${metadata.doi}`, kind: "doi" });
	let record: PaperRecord = {
		id: "",
		title: metadata.title!,
		authors: metadata.authors,
		abstract: doiRecord?.abstract,
		year: metadata.year,
		venue: metadata.venue,
		venueRank: doiRecord?.venueRank,
		publicationType: doiRecord?.publicationType,
		identifiers: { ...doiRecord?.identifiers, doi: metadata.doi, arxivId: metadata.arxivId },
		links,
		materialHashes: [materialHash],
		provenance: [
			{
				provider: "local-pdf",
				query: "local-pdf-import",
				retrievedAt: new Date().toISOString(),
				rawUrl: path,
			},
			...(doiRecord?.provenance ?? []),
		],
		citationCount: doiRecord?.citationCount,
		referencedWorks: doiRecord?.referencedWorks,
		citedByApiUrl: doiRecord?.citedByApiUrl,
		mergedFrom: [],
	};
	record.id = paperRecordId(record);
	if (options.enrich !== false) {
		const enriched = await enrichImportedPdfRecord(record, projectRoot, signal, options.searcher, options.doiLookup);
		record = enriched.record;
		warnings.push(...enriched.warnings);
	}
	return { record, warnings, metadataSource };
}
