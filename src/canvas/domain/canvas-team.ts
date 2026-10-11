interface TeamRelationNode {
	id: string;
	kind: string;
	title: string;
}

interface TeamRelationEdge {
	from: string;
	to: string;
	label: string;
}

export function getTeamLeaderNames(nodes: TeamRelationNode[], edges: TeamRelationEdge[], teamId: string): string {
	const authors = new Map(nodes.filter((node) => node.kind === "author").map((node) => [node.id, node]));
	const names = new Set<string>();
	for (const edge of edges) {
		if (edge.label.trim() !== "负责人") continue;
		const authorId = edge.from === teamId ? edge.to : edge.to === teamId ? edge.from : undefined;
		const author = authorId ? authors.get(authorId) : undefined;
		if (author?.title.trim() && author.title !== "作者姓名") names.add(author.title.trim());
	}
	return [...names].join("、");
}

export function getTeamMemberNames(
	nodes: TeamRelationNode[],
	edges: TeamRelationEdge[],
	teamId: string,
	manualMembers: string[],
	fallbackLeader: string,
): string[] {
	const authors = new Map(nodes.filter((node) => node.kind === "author").map((node) => [node.id, node]));
	const names = new Map<string, string>();
	const add = (name: string) => {
		const trimmed = name.trim();
		if (trimmed && trimmed !== "作者姓名") names.set(trimmed.toLocaleLowerCase(), trimmed);
	};
	for (const edge of edges) {
		if (edge.label.trim() !== "负责人") continue;
		const authorId = edge.from === teamId ? edge.to : edge.to === teamId ? edge.from : undefined;
		const author = authorId ? authors.get(authorId) : undefined;
		if (author) add(author.title);
	}
	if (!names.size) add(fallbackLeader);
	for (const name of manualMembers) add(name);
	for (const edge of edges) {
		if (edge.label.trim() !== "成员") continue;
		const authorId = edge.from === teamId ? edge.to : edge.to === teamId ? edge.from : undefined;
		const author = authorId ? authors.get(authorId) : undefined;
		if (author) add(author.title);
	}
	return [...names.values()];
}
