import { existsSync } from "node:fs";
import type {
	ConfirmationGrant,
	OperationConsentManager,
	OperationPlan,
	PreparedOperation,
} from "../../shared/application/operation-consent.ts";
import { decodeTeamInvite, encodeTeamInvite, type ResolvedTeamAccess, type TeamAccess } from "../domain/team-access.ts";
import { canAccessTeamNamespace, type TeamIdentityAction, type TeamIdentityInput } from "../domain/team-identity.ts";
import { clearTeamAccess, saveTeamAccess, teamAccessFile, validateTeamCa } from "../infrastructure/team-access-file.ts";
import { resolveTeamConnection, teamConnectionFingerprint } from "./team-connection.ts";
import { TeamCorpusClient } from "./team-corpus-client.ts";

export type TeamAccessChange =
	| { action: "connect"; invite: string }
	| { action: "switch"; namespace: string }
	| { action: "clear" };
export interface TeamMemberChange extends TeamIdentityInput {
	action: "create" | TeamIdentityAction;
	id?: string;
}
interface Pending {
	prepared: PreparedOperation;
	plan: OperationPlan;
	connection?: ResolvedTeamAccess;
	access?: TeamAccess;
	member?: TeamMemberChange;
	action: string;
	timer: ReturnType<typeof setTimeout>;
}

function clientFor(connection: TeamAccess): TeamCorpusClient {
	return new TeamCorpusClient({ baseUrl: connection.serverUrl, token: connection.token, caPem: connection.caPem });
}

async function validateConnection(connection: TeamAccess) {
	validateTeamCa(connection.caPem);
	const client = clientFor(connection);
	const health = await client.health();
	if (!health.ok || health.service !== "paper-agent-team-corpus") throw new Error("目标地址不是 Paper Agent 团队服务");
	const { identity } = await client.whoAmI();
	if (!canAccessTeamNamespace(identity, connection.namespace)) throw new Error("当前身份未获准访问该团队空间");
	return identity;
}

function currentConnection(root: string): { connection?: ResolvedTeamAccess; error?: string } {
	try {
		return { connection: resolveTeamConnection(root) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "团队接入文件无效" };
	}
}

export class TeamAccessService {
	private readonly root: string;
	private readonly consent: OperationConsentManager;
	private readonly pending = new Map<string, Pending>();
	private executing: Promise<void> = Promise.resolve();
	constructor(root: string, consent: OperationConsentManager) {
		this.root = root;
		this.consent = consent;
	}

	async status() {
		const resolved = currentConnection(this.root);
		const connection = resolved.connection;
		const hasLocalAccess = existsSync(teamAccessFile(this.root));
		if (!connection)
			return {
				connected: false,
				configured: hasLocalAccess,
				source: hasLocalAccess ? ("access-file" as const) : null,
				hasLocalAccess,
				...(resolved.error ? { reason: resolved.error } : {}),
			};
		const status = {
			configured: true,
			source: connection.source,
			serverUrl: connection.serverUrl,
			namespace: connection.namespace,
			hasLocalAccess,
		};
		try {
			return { ...status, connected: true, identity: await validateConnection(connection) };
		} catch (error) {
			return { ...status, connected: false, reason: error instanceof Error ? error.message : "团队连接失败" };
		}
	}

	private async remember(
		action: string,
		connection: ResolvedTeamAccess | undefined,
		details: Record<string, unknown>,
		access?: TeamAccess,
		member?: TeamMemberChange,
	) {
		if (this.pending.size >= 20) throw new Error("待确认的团队操作过多，请先取消已有操作");
		const plan: OperationPlan = {
			kind: "team-token-management",
			summary: `团队操作：${action}`,
			targets: [
				{ label: "团队服务", value: access?.serverUrl ?? connection?.serverUrl ?? "本地接入", risk: "high" },
			],
			details: { ...details, connectionFingerprint: teamConnectionFingerprint(connection), token: "[redacted]" },
		};
		const prepared = await this.consent.prepare(plan);
		const timer = setTimeout(
			() => this.cancel(prepared.operationId),
			Math.max(1, Date.parse(prepared.expiresAt) - Date.now()),
		);
		timer.unref();
		this.pending.set(prepared.operationId, { prepared, plan, connection, access, member, action, timer });
		return prepared;
	}

	async prepareAccess(input: TeamAccessChange) {
		const connection = currentConnection(this.root).connection;
		if (input.action === "clear") return this.remember("clear", connection, { action: "clear" });
		let access: TeamAccess;
		if (input.action === "connect") access = decodeTeamInvite(input.invite);
		else if (input.action === "switch" && connection) access = { ...connection, namespace: input.namespace };
		else throw new Error("无效的团队接入操作");
		const identity = await validateConnection(access);
		access = { ...access, identity: identity.name };
		return this.remember(
			input.action,
			connection,
			{
				action: input.action,
				namespace: access.namespace,
				identity: { id: identity.id, name: identity.name, roles: identity.roles, namespaces: identity.namespaces },
			},
			access,
		);
	}

	async prepareMember(input: TeamMemberChange) {
		const connection = currentConnection(this.root).connection;
		if (!connection) throw new Error("请先接入团队服务");
		const actor = await validateConnection(connection);
		if (!actor.roles.includes("admin")) throw new Error("此操作需要管理员权限");
		if (!["create", "rotate", "revoke", "rename", "ban", "unban", "delete"].includes(input.action))
			throw new Error("无效成员操作");
		if (input.action !== "create" && !input.id) throw new Error("缺少成员 ID");
		// Keep only supported fields. Caller-supplied secrets must never enter a manifest.
		const member: TeamMemberChange = {
			action: input.action,
			id: input.id,
			name: input.name,
			roles: input.roles,
			namespaces: input.namespaces,
			expiresAt: input.expiresAt,
			reason: input.reason,
		};
		return this.remember(
			input.action,
			connection,
			{ actorId: actor.id, namespace: connection.namespace, member },
			undefined,
			member,
		);
	}

	cancel(operationId: string): void {
		const pending = this.pending.get(operationId);
		if (pending) clearTimeout(pending.timer);
		this.pending.delete(operationId);
	}

	execute(grant: ConfirmationGrant) {
		const operation = this.executing.then(() => this.executeOne(grant));
		this.executing = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async executeOne(grant: ConfirmationGrant) {
		const pending = this.pending.get(grant.operationId);
		if (!pending) throw new Error("团队操作已取消、执行或过期");
		this.cancel(grant.operationId);
		if (
			teamConnectionFingerprint(currentConnection(this.root).connection) !==
			teamConnectionFingerprint(pending.connection)
		)
			throw new Error("团队连接已改变，请重新准备操作");
		await this.consent.consume(grant, pending.plan);
		if (pending.member && pending.connection) {
			const actor = await validateConnection(pending.connection);
			if (actor.id !== pending.prepared.details.actorId) throw new Error("团队身份已改变");
			const client = clientFor(pending.connection);
			const result =
				pending.member.action === "create"
					? await client.createIdentity(pending.member)
					: await client.changeIdentity(pending.member.id!, pending.member.action, pending.member);
			const namespace =
				result.identity.roles.includes("admin") || result.identity.namespaces.includes(pending.connection.namespace)
					? pending.connection.namespace
					: result.identity.namespaces[0];
			return {
				identity: result.identity,
				invite: result.token
					? encodeTeamInvite({
							serverUrl: pending.connection.serverUrl,
							token: result.token,
							namespace,
							identity: result.identity.name,
							caPem: pending.connection.caPem,
						})
					: undefined,
			};
		}
		if (pending.action === "clear") await clearTeamAccess(this.root);
		else if (pending.access) {
			await validateConnection(pending.access);
			await saveTeamAccess(this.root, pending.access);
		}
		for (const id of this.pending.keys()) this.cancel(id);
		return { status: await this.status() };
	}
}
