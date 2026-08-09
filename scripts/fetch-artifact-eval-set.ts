import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fetchPublicUrl, readResponseBody } from "../src/network-security.ts";

interface ArtifactEvaluationSource {
	slug: string;
	title: string;
	paperId?: string;
	pdfPath: string;
	pdfSha256?: string;
	sourceUrl: string;
	status: "available" | "pending-download";
	tags?: string[];
}

const projectRoot = resolve(import.meta.dirname, "..");
const artifactRoot = resolve(projectRoot, process.argv[2] ?? "eval-data/artifacts");
const sourcePath = resolve(artifactRoot, "sources.json");
const pdfRoot = resolve(projectRoot, "eval-data/pdfs");
const acceptNewHashes = process.argv.includes("--accept-new-hashes");
const maximumBytes = 64 * 1024 * 1024;
const allowedHosts = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"]);
const sources = JSON.parse(await readFile(sourcePath, "utf8")) as ArtifactEvaluationSource[];
const updated = structuredClone(sources);
const summary = {
	verified: 0,
	downloaded: 0,
	pinned: 0,
	failed: [] as Array<{ slug: string; error: string }>,
};

function arxivPdfUrl(source: ArtifactEvaluationSource): URL {
	const input = new URL(source.sourceUrl);
	if (input.protocol !== "https:" || !allowedHosts.has(input.hostname.toLowerCase())) {
		throw new Error("sourceUrl must use HTTPS on an allowed arXiv host");
	}
	const match = input.pathname.match(/^\/(?:abs|pdf)\/([^/]+?)(?:\.pdf)?$/);
	if (!match?.[1]) throw new Error("sourceUrl must identify one arXiv paper");
	return new URL(`https://arxiv.org/pdf/${encodeURIComponent(match[1])}`);
}

async function sha256(path: string): Promise<string | undefined> {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

for (const [index, source] of sources.entries()) {
	try {
		const destination = resolve(artifactRoot, source.pdfPath);
		const destinationRelative = relative(pdfRoot, destination);
		if (!destinationRelative || destinationRelative.startsWith("..") || isAbsolute(destinationRelative)) {
			throw new Error("pdfPath must resolve to one file under eval-data/pdfs");
		}
		const existingHash = await sha256(destination);
		if (existingHash && source.pdfSha256 && existingHash === source.pdfSha256.toLowerCase()) {
			console.log(`verified ${basename(destination)}`);
			summary.verified++;
			continue;
		}
		if (existingHash && source.pdfSha256 && existingHash !== source.pdfSha256.toLowerCase()) {
			throw new Error(`cached SHA-256 mismatch: expected ${source.pdfSha256}, found ${existingHash}`);
		}
		if (existingHash && !source.pdfSha256) {
			if (!acceptNewHashes) {
				throw new Error(
					`cached PDF hash ${existingHash} is not pinned; rerun with --accept-new-hashes after reviewing the source entry`,
				);
			}
			const cached = await readFile(destination);
			if (cached.length > maximumBytes || !cached.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
				throw new Error("cached file is not a valid bounded PDF");
			}
			updated[index].pdfSha256 = existingHash;
			updated[index].status = "available";
			summary.verified++;
			summary.pinned++;
			console.log(`pinned ${basename(destination)} (sha256 ${existingHash})`);
			continue;
		}

		const requestedUrl = arxivPdfUrl(source);
		const { response, finalUrl } = await fetchPublicUrl(requestedUrl, {
			requireHttps: true,
			timeoutMs: 120_000,
			maxRetries: 2,
			maxRedirects: 5,
			init: { headers: { Accept: "application/pdf" } },
		});
		if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
		if (!allowedHosts.has(finalUrl.hostname.toLowerCase())) {
			throw new Error(`redirected outside the allowed arXiv hosts: ${finalUrl.hostname}`);
		}
		const pdf = await readResponseBody(response, maximumBytes);
		if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("response is not a PDF");
		const actualHash = createHash("sha256").update(pdf).digest("hex");
		if (source.pdfSha256 && actualHash !== source.pdfSha256.toLowerCase()) {
			throw new Error(`SHA-256 mismatch: expected ${source.pdfSha256}, received ${actualHash}`);
		}
		if (!source.pdfSha256 && !acceptNewHashes) {
			throw new Error(
				`new PDF hash ${actualHash} is not pinned; rerun with --accept-new-hashes after reviewing the source entry`,
			);
		}

		await mkdir(dirname(destination), { recursive: true });
		const temporary = `${destination}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, pdf, { flag: "wx" });
			await rename(temporary, destination);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
		console.log(`downloaded ${basename(destination)} (${pdf.length} bytes, sha256 ${actualHash})`);
		summary.downloaded++;
		if (!source.pdfSha256) {
			updated[index].pdfSha256 = actualHash;
			updated[index].status = "available";
			summary.pinned++;
		}
	} catch (error) {
		summary.failed.push({ slug: source.slug, error: error instanceof Error ? error.message : String(error) });
	}
}

if (summary.pinned) {
	const temporary = `${sourcePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" });
		await rename(temporary, sourcePath);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

console.log(JSON.stringify({ sourcePath, sourceCount: sources.length, acceptNewHashes, ...summary }, null, 2));
if (summary.failed.length) process.exitCode = 1;
