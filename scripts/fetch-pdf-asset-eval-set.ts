import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AssetEvaluationDataset } from "../src/tools/pdf-asset-evaluation.ts";

const annotationsDirectory = resolve(process.argv[2] ?? "eval-data/annotations");
const maximumBytes = 64 * 1024 * 1024;
for (const name of (await readdir(annotationsDirectory)).filter((value) => value.endsWith(".json")).sort()) {
	const annotationPath = join(annotationsDirectory, name);
	const dataset = JSON.parse(await readFile(annotationPath, "utf8")) as AssetEvaluationDataset;
	if (!dataset.pdfSha256 || !dataset.metadata?.sourceUrl) throw new Error(`${name} lacks pdfSha256 or sourceUrl`);
	const destination = resolve(dirname(annotationPath), dataset.pdfPath);
	try {
		const existingHash = createHash("sha256")
			.update(await readFile(destination))
			.digest("hex");
		if (existingHash === dataset.pdfSha256) {
			console.log(`verified ${basename(destination)}`);
			continue;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const source = new URL(dataset.metadata.sourceUrl);
	if (source.protocol !== "https:" || !["arxiv.org", "www.arxiv.org"].includes(source.hostname)) {
		throw new Error(`${name} sourceUrl must use HTTPS on arxiv.org`);
	}
	const paperId = source.pathname.match(/^\/abs\/([^/]+)$/)?.[1];
	if (!paperId) throw new Error(`${name} sourceUrl must be an arXiv abstract URL`);
	const response = await fetch(`https://arxiv.org/pdf/${encodeURIComponent(paperId)}`, {
		redirect: "follow",
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok || !response.body) throw new Error(`${name} download failed with HTTP ${response.status}`);
	const finalUrl = new URL(response.url);
	if (
		finalUrl.protocol !== "https:" ||
		!["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(finalUrl.hostname)
	) {
		throw new Error(`${name} redirected outside the allowed arXiv hosts`);
	}
	const declaredLength = Number(response.headers.get("content-length") ?? 0);
	if (declaredLength > maximumBytes) throw new Error(`${name} exceeds the ${maximumBytes}-byte limit`);
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of response.body) {
		total += chunk.byteLength;
		if (total > maximumBytes) throw new Error(`${name} exceeds the ${maximumBytes}-byte limit`);
		chunks.push(chunk);
	}
	const pdf = Buffer.concat(chunks);
	if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error(`${name} response is not a PDF`);
	const actualHash = createHash("sha256").update(pdf).digest("hex");
	if (actualHash !== dataset.pdfSha256) {
		throw new Error(`${name} SHA-256 mismatch: expected ${dataset.pdfSha256}, received ${actualHash}`);
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
	console.log(`downloaded ${basename(destination)} (${total} bytes)`);
}
