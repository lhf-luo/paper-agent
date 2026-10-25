import { createInterface } from "node:readline";

if (process.argv.includes("--fail")) {
	process.stderr.write(`fixture failed: ${process.env.TEST_TOKEN ?? "no token"}`);
	process.exit(2);
}
const pending = new Map();
let sequence = 0;
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const schema = {
	type: "object",
	properties: { text: { type: "string" }, namespace: { type: "string" }, delay: { type: "number" } },
};
const definitions = ["echo", "wait", "error", "image", "exit"].map((name) => ({
	name,
	description: `Fixture ${name}`,
	inputSchema: schema,
}));
createInterface({ input: process.stdin })
	.on("line", (line) => {
		const request = JSON.parse(line);
		if (request.method === "notifications/cancelled") {
			clearTimeout(pending.get(request.params.requestId));
			pending.delete(request.params.requestId);
			return;
		}
		if (request.id === undefined) return;
		if (request.method === "initialize")
			return send(request.id, {
				protocolVersion: request.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "paper-agent-test", version: "1" },
			});
		if (request.method === "tools/list")
			return send(
				request.id,
				request.params?.cursor
					? { tools: definitions.slice(2) }
					: { tools: definitions.slice(0, 2), nextCursor: "page-2" },
			);
		if (request.method === "tools/call") {
			const { name, arguments: args } = request.params;
			if (name === "error")
				return send(request.id, { isError: true, content: [{ type: "text", text: "fixture tool failed" }] });
			if (name === "image")
				return send(request.id, {
					content: [
						{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
						{ type: "text", text: "image returned" },
					],
				});
			const order = ++sequence;
			const finish = () => {
				pending.delete(request.id);
				send(request.id, {
					content: [{ type: "text", text: JSON.stringify({ pid: process.pid, sequence: order, args }) }],
				});
			};
			if (name === "wait") pending.set(request.id, setTimeout(finish, args.delay ?? 100));
			else finish();
			if (name === "exit") setTimeout(() => process.exit(0), 10);
			return;
		}
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } })}\n`,
		);
	})
	.on("close", () => {
		for (const timer of pending.values()) clearTimeout(timer);
		process.exit(0);
	});
