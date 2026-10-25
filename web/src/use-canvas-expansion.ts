import { useEffect, useRef, useState } from "react";
import { api, jsonBody } from "./api";
import { useJob } from "./components";
import type { PaperRecord, BackgroundJob } from "./types";
function useExpansionDraft(props: ExpansionProps) {
	const [paperId, setPaperId] = useState(props.initialPaperId ?? props.papers[0]?.id ?? ""),
		[kind, setKind] = useState(props.initialKind);
	const [author, setAuthor] = useState(""),
		[direction, setDirection] = useState("both"),
		[from, setFrom] = useState(""),
		[to, setTo] = useState(""),
		[limit, setLimit] = useState(30);

	return {
		paperId,
		setPaperId,
		kind,
		setKind,
		author,
		setAuthor,
		direction,
		setDirection,
		from,
		setFrom,
		to,
		setTo,
		limit,
		setLimit,
	};
}
export interface ExpansionProps {
	canvasId: string;
	papers: PaperRecord[];
	initialPaperId?: string;
	initialKind: "citation" | "author";
	onClose: () => void;
	onReady: (runId: string) => Promise<void>;
}
export function useExpansion(props: ExpansionProps) {
	const draft = useExpansionDraft(props);
	const { paperId, kind, author, direction, from, to, limit } = draft;
	const [jobId, setJobId] = useState<string>(),
		[busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const paper = props.papers.find((p) => p.id === paperId),
		job = useJob(jobId),
		submission = useRef<{ payload: string; id: string } | undefined>(undefined);
	const running =
		busy || Boolean(jobId && !job) || Boolean(job && ["queued", "running", "paused"].includes(job.status));
	useExpansionCompletion(job, props, setError);
	const start = () =>
		submitExpansion(
			props.canvasId,
			{
				paperId,
				kind,
				authorName: kind === "author" ? author || paper?.authors[0] : undefined,
				direction,
				yearFrom: from ? Number(from) : undefined,
				yearTo: to ? Number(to) : undefined,
				limit,
			},
			submission,
			setBusy,
			setError,
			setJobId,
		);
	const cancel = async () => {
		if (!jobId) return;
		try {
			await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, jsonBody({}));
		} catch (e) {
			setError(String(e));
		}
	};
	const again = () => {
		submission.current = undefined;
		setJobId(undefined);
	};
	return {
		...draft,
		paper,
		job,
		running,
		error,
		start,
		cancel,
		again,
	};
}
async function submitExpansion(
	canvasId: string,
	input: Record<string, unknown>,
	submission: React.RefObject<{ payload: string; id: string } | undefined>,
	setBusy: (v: boolean) => void,
	setError: (v: string) => void,
	setJobId: (v: string) => void,
) {
	setError("");
	setBusy(true);
	const payload = JSON.stringify(input);
	if (submission.current?.payload !== payload) submission.current = { payload, id: crypto.randomUUID() };
	try {
		const job = await api<BackgroundJob>(
			`/api/canvases/${encodeURIComponent(canvasId)}/expansions`,
			jsonBody({ ...input, requestId: submission.current.id }),
		);
		setJobId(job.id);
	} catch (e) {
		setError(String(e));
	} finally {
		setBusy(false);
	}
}

function useExpansionCompletion(job: BackgroundJob | undefined, props: ExpansionProps, setError: (s: string) => void) {
	const completed = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (
			job?.status !== "succeeded" ||
			!job.result?.graphOpened ||
			!job.result.searchRunId ||
			completed.current === job.id
		)
			return;
		completed.current = job.id;
		void props
			.onReady(job.result.searchRunId)
			.then(props.onClose)
			.catch((e) => setError(String(e)));
	}, [job, props.onReady, props.onClose, setError]);
}
