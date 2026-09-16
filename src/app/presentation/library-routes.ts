import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import {
	LOCAL_PDF_IMPORT_MAX_FILE_BYTES,
	LocalPdfImportError,
} from "../../literature/application/local-pdf-import-batches.ts";
import type { ScreeningStatus } from "../../literature/domain/literature-types.ts";
import type {
	PaperAgentApplication,
	PersonalCorpusAnnotationInput,
	PersonalCorpusExportInput,
	PersonalPaperRemovalInput,
	PersonalTitleRepairInput,
} from "../application/paper-agent-application.ts";
import { sendPdfResponse } from "./pdf-response.ts";
import {
	ApiError,
	boundedStringArray,
	grantFromBody,
	json,
	namespaceValue,
	numberValue,
	readBinary,
	readJson,
	screeningStatusValue,
	stringArray,
} from "./web-http.ts";

export async function handleLibraryRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<void> {
	const localImportRoute = /^\/api\/library\/local-imports(?:\/([^/]+)(?:\/(files|prepare|execute))?)?$/.exec(
		url.pathname,
	);
	if (localImportRoute) {
		try {
			const batchId = localImportRoute[1] ? decodeURIComponent(localImportRoute[1]) : undefined;
			const action = localImportRoute[2];
			if (request.method === "POST" && !batchId) {
				const body = await readJson(request);
				json(
					response,
					201,
					await application.createLocalPdfImportBatch(
						namespaceValue(body.namespace),
						typeof body.collectionId === "string" ? body.collectionId : undefined,
					),
				);
				return;
			}
			if (!batchId) throw new ApiError(404, "Local PDF import route not found");
			if (request.method === "POST" && action === "files") {
				if (
					!String(request.headers["content-type"] ?? "")
						.toLowerCase()
						.startsWith("application/pdf")
				) {
					throw new ApiError(415, "content-type must be application/pdf");
				}
				const header = request.headers["x-filename"];
				if (typeof header !== "string") throw new ApiError(400, "x-filename is required");
				let filename = header;
				try {
					filename = decodeURIComponent(header);
				} catch {
					// Keep the original filename when it was not URL-encoded.
				}
				const data = await readBinary(request, LOCAL_PDF_IMPORT_MAX_FILE_BYTES);
				json(response, 201, await application.addLocalPdfImportFile(batchId, filename, data));
				return;
			}
			if (request.method === "POST" && action === "prepare") {
				json(response, 200, await application.prepareLocalPdfImport(batchId));
				return;
			}
			if (request.method === "POST" && action === "execute") {
				json(
					response,
					200,
					await application.executeLocalPdfImport(batchId, grantFromBody(await readJson(request))),
				);
				return;
			}
			if (request.method === "DELETE" && !action) {
				json(response, 200, await application.cancelLocalPdfImport(batchId));
				return;
			}
			throw new ApiError(404, "Local PDF import route not found");
		} catch (error) {
			if (error instanceof LocalPdfImportError) throw new ApiError(error.status, error.message);
			throw error;
		}
	}
	if (request.method === "GET" && url.pathname === "/api/library/pdfs") {
		json(response, 200, {
			pdfs: await application.listAvailablePdfs(url.searchParams.get("namespace") ?? undefined),
		});
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/library/collections") {
		json(response, 200, await application.listLibraryCollections(url.searchParams.get("namespace") ?? undefined));
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/library/collection-memberships") {
		json(
			response,
			200,
			await application.libraryCollectionMemberships(url.searchParams.get("namespace") ?? undefined),
		);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/library/collections") {
		const body = await readJson(request);
		if (typeof body.name !== "string" || !body.name.trim()) throw new ApiError(400, "name is required");
		json(
			response,
			201,
			await application.createLibraryCollection(
				body.name,
				typeof body.parentId === "string" ? body.parentId : undefined,
				typeof body.namespace === "string" ? body.namespace : undefined,
			),
		);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/library") {
		json(
			response,
			200,
			await application.searchPersonalLibrary({
				query: url.searchParams.get("q") ?? undefined,
				namespace: url.searchParams.get("namespace") ?? undefined,
				yearFrom: numberValue(url.searchParams.get("yearFrom")),
				yearTo: numberValue(url.searchParams.get("yearTo")),
				collectionId: url.searchParams.get("collection") ?? undefined,
				tags: url.searchParams.getAll("tag"),
				screeningStatuses: url.searchParams
					.getAll("screeningStatus")
					.map((value) => screeningStatusValue(value) as ScreeningStatus),
				limit: numberValue(url.searchParams.get("limit"), 100),
			}),
		);
		return;
	}
	if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/local-pdf") {
		const path = url.searchParams.get("path");
		if (!path) throw new ApiError(400, "path is required");
		const pdf = await application.readLocalPdf(path);
		sendPdfResponse({
			request,
			response,
			body: pdf.body,
			filename: pdf.path.split(/[\\/]/).at(-1) ?? "paper.pdf",
			etag: `${pdf.body.length}-${pdf.body.subarray(0, 32).toString("hex")}`,
		});
		return;
	}
	const collectionRoute = /^\/api\/library\/collections\/([^/]+)$/.exec(url.pathname);
	if (collectionRoute) {
		const id = decodeURIComponent(collectionRoute[1]);
		const namespace = url.searchParams.get("namespace") ?? undefined;
		if (request.method === "PATCH") {
			const body = await readJson(request);
			const hasName = Object.hasOwn(body, "name");
			const hasParentId = Object.hasOwn(body, "parentId");
			if (!hasName && !hasParentId) throw new ApiError(400, "name or parentId is required");
			if (hasName && (typeof body.name !== "string" || !body.name.trim())) {
				throw new ApiError(400, "name must be a non-empty string");
			}
			if (hasParentId && body.parentId !== null && typeof body.parentId !== "string") {
				throw new ApiError(400, "parentId must be a string or null");
			}
			json(
				response,
				200,
				await application.updateLibraryCollection(
					id,
					{
						name: hasName ? (body.name as string) : undefined,
						parentId: hasParentId ? (body.parentId as string | null) : undefined,
					},
					namespace,
				),
			);
			return;
		}
		if (request.method === "DELETE") {
			const deletedCollectionIds = await application.deleteLibraryCollection(id, namespace);
			json(response, 200, { ok: true, deletedCollectionIds });
			return;
		}
	}
	const collectionPapersRoute = /^\/api\/library\/collections\/([^/]+)\/papers$/.exec(url.pathname);
	if (request.method === "PATCH" && collectionPapersRoute) {
		const body = await readJson(request);
		const paperIds = boundedStringArray(body.paperIds, "paperIds", 500, 500);
		if (!paperIds?.length) throw new ApiError(400, "paperIds is required");
		if (body.mode !== "assign") throw new ApiError(400, 'mode must be "assign"');
		json(
			response,
			200,
			await application.updateLibraryCollectionMembership(
				decodeURIComponent(collectionPapersRoute[1]),
				paperIds,
				"assign",
				typeof body.namespace === "string" ? body.namespace : undefined,
			),
		);
		return;
	}
	const paperCollectionsRoute = /^\/api\/papers\/([^/]+)\/collections$/.exec(url.pathname);
	if (request.method === "PATCH" && paperCollectionsRoute) {
		const body = await readJson(request);
		const collectionIds = Array.isArray(body.collectionIds)
			? body.collectionIds.filter((value: unknown) => typeof value === "string")
			: [];
		json(
			response,
			200,
			await application.setPaperCollections(
				decodeURIComponent(paperCollectionsRoute[1]),
				collectionIds,
				typeof body.namespace === "string" ? body.namespace : undefined,
			),
		);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/library/papers/remove/prepare" || url.pathname === "/api/library/papers/remove/execute")
	) {
		const body = await readJson(request);
		const paperIds = boundedStringArray(body.paperIds, "paperIds", 1_000, 500);
		if (typeof body.paperId !== "string" && !paperIds?.length) {
			throw new ApiError(400, "paperId or paperIds is required");
		}
		const input: PersonalPaperRemovalInput = {
			paperId: typeof body.paperId === "string" ? body.paperId : undefined,
			paperIds,
			namespace: namespaceValue(body.namespace),
			collectionId: typeof body.collectionId === "string" ? body.collectionId : undefined,
			author: typeof body.author === "string" ? body.author : undefined,
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.preparePersonalPaperRemoval(input)
				: await application.removePersonalPaper(input, grantFromBody(body)),
		);
		return;
	}
	const artifactFolderRoute = /^\/api\/papers\/([^/]+)\/artifacts\/open$/.exec(url.pathname);
	if (request.method === "POST" && artifactFolderRoute) {
		json(
			response,
			200,
			await application.openPaperArtifactFolder(
				decodeURIComponent(artifactFolderRoute[1]),
				url.searchParams.get("namespace") ?? undefined,
			),
		);
		return;
	}
	const pdfFolderRoute = /^\/api\/papers\/([^/]+)\/pdf\/([a-f0-9]{64})\/folder\/open$/.exec(url.pathname);
	if (request.method === "POST" && pdfFolderRoute) {
		json(
			response,
			200,
			await application.openPaperPdfFolder(
				decodeURIComponent(pdfFolderRoute[1]),
				pdfFolderRoute[2],
				url.searchParams.get("namespace") ?? undefined,
			),
		);
		return;
	}
	const paperRoute = /^\/api\/papers\/([^/]+)$/.exec(url.pathname);
	if (request.method === "GET" && paperRoute) {
		const details = await application.paperDetails(
			decodeURIComponent(paperRoute[1]),
			url.searchParams.get("namespace") ?? undefined,
		);
		json(response, details ? 200 : 404, details ?? { error: "Paper not found" });
		return;
	}
	const pdfBlobRoute = /^\/api\/papers\/([^/]+)\/pdf\/([a-f0-9]{64})$/.exec(url.pathname);
	const pdfUploadRoute = /^\/api\/papers\/([^/]+)\/pdf$/.exec(url.pathname);
	if ((request.method === "GET" || request.method === "HEAD") && pdfBlobRoute) {
		const paperId = decodeURIComponent(pdfBlobRoute[1]);
		const namespace = url.searchParams.get("namespace") ?? undefined;
		const body = await application.readPdfVersionBlob(paperId, pdfBlobRoute[2], namespace);
		const details = await application.paperDetails(paperId, namespace);
		sendPdfResponse({
			request,
			response,
			body,
			filename: details?.paper.title ?? paperId,
			etag: pdfBlobRoute[2],
		});
		return;
	}
	if (request.method === "POST" && pdfUploadRoute) {
		// 从本地加载 PDF 并关联到论文(用户网页手动下载后上传)。
		const paperId = decodeURIComponent(pdfUploadRoute[1]);
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const data = Buffer.concat(chunks);
		if (data.length < 3 || data.subarray(0, 5).toString("latin1") !== "%PDF-") {
			throw new ApiError(400, "上传的文件不是有效的 PDF");
		}
		json(
			response,
			200,
			await application.addLocalPdfToPaper(paperId, data, url.searchParams.get("namespace") ?? undefined),
		);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/library/import/prepare") {
		const body = await readJson(request);
		if (
			typeof body.searchJobId !== "string" &&
			typeof body.searchRunId !== "string" &&
			typeof body.sidebarResultUrl !== "string"
		) {
			throw new ApiError(400, "searchJobId, searchRunId, or sidebarResultUrl is required");
		}
		json(
			response,
			200,
			await application.prepareCorpusImport({
				searchJobId: typeof body.searchJobId === "string" ? body.searchJobId : undefined,
				searchRunId: typeof body.searchRunId === "string" ? body.searchRunId : undefined,
				sidebarResultUrl: typeof body.sidebarResultUrl === "string" ? body.sidebarResultUrl : undefined,
				paperIds: stringArray(body.paperIds),
				namespace: typeof body.namespace === "string" ? body.namespace : undefined,
				collectionId: typeof body.collectionId === "string" ? body.collectionId : undefined,
			}),
		);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/library/annotations/prepare" || url.pathname === "/api/library/annotations/execute")
	) {
		const body = await readJson(request);
		const input: PersonalCorpusAnnotationInput = {
			paperIds: boundedStringArray(body.paperIds, "paperIds", 500, 500) ?? [],
			namespace: namespaceValue(body.namespace),
			author: typeof body.author === "string" ? body.author : undefined,
			tags: boundedStringArray(body.tags, "tags", 50, 100),
			note: typeof body.note === "string" ? body.note : undefined,
			screeningStatus: screeningStatusValue(body.screeningStatus),
			screeningReason: typeof body.screeningReason === "string" ? body.screeningReason : undefined,
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.preparePersonalAnnotation(input)
				: await application.annotatePersonalPapers(input, grantFromBody(body)),
		);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/library/titles/prepare" || url.pathname === "/api/library/titles/execute")
	) {
		const body = await readJson(request);
		const input: PersonalTitleRepairInput = {
			paperIds: boundedStringArray(body.paperIds, "paperIds", 5_000, 500),
			namespace: namespaceValue(body.namespace),
			author: typeof body.author === "string" ? body.author : undefined,
		};
		if (url.pathname.endsWith("/prepare")) {
			// No dirty titles means nothing to confirm; say so instead of failing the request.
			const prepared = await application.preparePersonalTitleRepair(input);
			json(response, 200, { prepared: prepared ?? null });
			return;
		}
		json(response, 200, await application.repairPersonalPaperTitles(input, grantFromBody(body)));
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/library/export/prepare" || url.pathname === "/api/library/export/execute")
	) {
		const body = await readJson(request);
		if (!["markdown", "csv", "bibtex", "json"].includes(String(body.format))) {
			throw new ApiError(400, "format must be markdown, csv, bibtex, or json");
		}
		const input: PersonalCorpusExportInput = {
			format: body.format as PersonalCorpusExportInput["format"],
			namespace: namespaceValue(body.namespace),
			paperIds: boundedStringArray(body.paperIds, "paperIds", 1000, 500),
			filename: typeof body.filename === "string" ? body.filename : undefined,
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.preparePersonalExport(input)
				: await application.exportPersonalCorpus(input, grantFromBody(body)),
		);
		return;
	}
	const personalExportRoute = /^\/api\/library\/exports\/([^/]+)$/.exec(url.pathname);
	if (request.method === "GET" && personalExportRoute) {
		const filename = decodeURIComponent(personalExportRoute[1]);
		const body = await application.readPersonalExport(filename, url.searchParams.get("namespace") ?? undefined);
		const extension = extname(filename).toLowerCase();
		response.writeHead(200, {
			"content-type":
				extension === ".json"
					? "application/json; charset=utf-8"
					: extension === ".csv"
						? "text/csv; charset=utf-8"
						: "text/plain; charset=utf-8",
			"content-length": body.length,
			"content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		});
		response.end(body);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/library/import/save") {
		const body = await readJson(request);
		if (
			typeof body.searchJobId !== "string" &&
			typeof body.searchRunId !== "string" &&
			typeof body.sidebarResultUrl !== "string"
		) {
			throw new ApiError(400, "searchJobId, searchRunId, or sidebarResultUrl is required");
		}
		json(
			response,
			202,
			await application.saveCorpusImport({
				searchJobId: typeof body.searchJobId === "string" ? body.searchJobId : undefined,
				searchRunId: typeof body.searchRunId === "string" ? body.searchRunId : undefined,
				sidebarResultUrl: typeof body.sidebarResultUrl === "string" ? body.sidebarResultUrl : undefined,
				paperIds: stringArray(body.paperIds),
				namespace: typeof body.namespace === "string" ? body.namespace : undefined,
				collectionId: typeof body.collectionId === "string" ? body.collectionId : undefined,
			}),
		);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/library/import/execute") {
		const body = await readJson(request);
		if (
			typeof body.searchJobId !== "string" &&
			typeof body.searchRunId !== "string" &&
			typeof body.sidebarResultUrl !== "string"
		) {
			throw new ApiError(400, "searchJobId, searchRunId, or sidebarResultUrl is required");
		}
		json(
			response,
			202,
			await application.enqueueAuthorizedCorpusImport(
				{
					searchJobId: typeof body.searchJobId === "string" ? body.searchJobId : undefined,
					searchRunId: typeof body.searchRunId === "string" ? body.searchRunId : undefined,
					sidebarResultUrl: typeof body.sidebarResultUrl === "string" ? body.sidebarResultUrl : undefined,
					paperIds: stringArray(body.paperIds),
					namespace: typeof body.namespace === "string" ? body.namespace : undefined,
					collectionId: typeof body.collectionId === "string" ? body.collectionId : undefined,
				},
				grantFromBody(body),
			),
		);
		return;
	}
	throw new ApiError(404, "Library API route not found");
}
