import { basename, dirname } from "node:path";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import { contiguousRanges } from "./pdf-layout.ts";

export interface EmbeddedImage {
	page: number;
	index: number;
	type: string;
	width: number;
	height: number;
	encoding: string;
	objectId: string;
	xPpi: number;
	yPpi: number;
	size: string;
}

export function parsePdfImagesList(output: string): EmbeddedImage[] {
	const images: EmbeddedImage[] = [];
	for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 15 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) continue;
		const page = Number(fields[0]);
		const index = Number(fields[1]);
		const width = Number(fields[3]);
		const height = Number(fields[4]);
		const numericObjectId = /^\d+$/.test(fields[10]) && /^\d+$/.test(fields[11]);
		const metricOffset = numericObjectId ? 12 : 11;
		const xPpi = Number(fields[metricOffset]);
		const yPpi = Number(fields[metricOffset + 1]);
		if (![page, index, width, height, xPpi, yPpi].every(Number.isFinite)) continue;
		images.push({
			page,
			index,
			type: fields[2],
			width,
			height,
			encoding: fields[8],
			objectId: numericObjectId ? `${fields[10]} ${fields[11]}` : fields[10],
			xPpi,
			yPpi,
			size: fields[metricOffset + 2],
		});
	}
	return images;
}

export async function listEmbeddedImages(
	pi: CommandExecutor,
	absolutePath: string,
	selectedPages: number[],
	signal?: AbortSignal,
): Promise<EmbeddedImage[]> {
	const images: EmbeddedImage[] = [];
	for (const range of contiguousRanges(selectedPages)) {
		const result = await pi.exec(
			"pdfimages",
			["-f", String(range.first), "-l", String(range.last), "-list", absolutePath],
			{ cwd: dirname(absolutePath), signal, timeout: 120_000 },
		);
		if (result.killed || signal?.aborted || result.code !== 0) {
			const reason = signal?.aborted
				? "operation aborted"
				: result.killed
					? "pdfimages was terminated or timed out"
					: result.stderr.trim() || "pdfimages -list exited with a non-zero status";
			throw new Error(`Could not list embedded images in ${basename(absolutePath)}: ${reason}`);
		}
		images.push(...parsePdfImagesList(result.stdout));
	}
	return images;
}
