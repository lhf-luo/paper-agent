import {
	Ban,
	KeyRound,
	Pencil,
	RotateCcw,
	ShieldCheck,
	ShieldOff,
	Trash2,
	UserCheck,
	UserPlus,
	Users,
} from "lucide-react";
import { useState } from "react";
import type { PublicTeamIdentity, TeamRole } from "../../src/team/domain/team-identity";
import { AccessibleModal } from "./components";

function localDate(value?: string): string {
	if (!value) return "";
	const date = new Date(value);
	return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function TeamMembersPanel({
	identities,
	selfId,
	namespace,
	prepare,
	busy,
}: {
	identities: PublicTeamIdentity[];
	selfId: string;
	namespace: string;
	busy: boolean;
	prepare: (preparePath: string, executePath: string, payload: Record<string, unknown>) => Promise<void>;
}) {
	const [editing, setEditing] = useState<{
		member?: PublicTeamIdentity;
		action: "create" | "rotate" | "rename" | "ban";
	}>();
	const [name, setName] = useState("");
	const [roles, setRoles] = useState<TeamRole[]>(["reader"]);
	const [namespaces, setNamespaces] = useState(namespace);
	const [expires, setExpires] = useState("");
	const [reason, setReason] = useState("");
	const open = (action: "create" | "rotate" | "rename" | "ban", member?: PublicTeamIdentity) => {
		setName(member?.name ?? "");
		setRoles(member?.roles ?? ["reader"]);
		setNamespaces(member?.namespaces.join(", ") ?? namespace);
		setExpires(localDate(member?.expiresAt));
		setReason("");
		setEditing({ action, member });
	};
	const send = async (payload: Record<string, unknown>) => {
		await prepare("/api/team/identities/prepare", "/api/team/identities/execute", payload);
		setEditing(undefined);
	};
	const submit = () => {
		if (!editing) return;
		const grants = editing.action === "create" || editing.action === "rotate";
		void send({
			action: editing.action,
			id: editing.member?.id,
			...(editing.action !== "ban" ? { name: name.trim() } : { reason: reason.trim() }),
			...(grants
				? {
						roles,
						namespaces: [...new Set(namespaces.split(/[,，\s]+/).filter(Boolean))],
						expiresAt: expires ? new Date(expires).toISOString() : null,
					}
				: {}),
		});
	};
	return (
		<div className="members-panel-root">
			<div className="sub-section-header members-panel-header">
				<div className="sub-section-icon-box">
					<Users size={16} />
				</div>
				<div className="sub-section-titles">
					<h4>成员管理</h4>
					<small>签发、轮换与回收团队接入凭据；所有变更都会进入审计账本。</small>
				</div>
				<button
					type="button"
					className="avant-btn avant-btn-primary members-create-btn"
					disabled={busy}
					onClick={() => open("create")}
				>
					<UserPlus size={14} />
					创建成员
				</button>
			</div>
			<div className="members-ledger">
				{identities.map((member) => {
					const statusTag = member.revokedAt ? (
						<span className="member-state-tag revoked">已撤销</span>
					) : member.bannedAt ? (
						<span className="member-state-tag banned">已封禁</span>
					) : (
						<span className="member-state-tag active">正常</span>
					);
					return (
						<article className="member-ledger-row" key={member.id}>
							<div className="member-ledger-info">
								<div className="member-ledger-name-row">
									<strong>{member.name}</strong>
									{member.id === selfId && <span className="member-self-tag">当前身份</span>}
									{statusTag}
								</div>
								<div className="member-ledger-roles">
									{member.roles.map((role) => (
										<span key={role} className={`role-chip role-${role}`}>
											<ShieldCheck size={10} />
											{role.toUpperCase()}
										</span>
									))}
								</div>
								<small>
									空间：{member.roles.includes("admin") ? "全部空间" : member.namespaces.join(", ")} ·{" "}
									{member.bannedAt ? `封禁原因：${member.banReason ?? "未注明"} · ` : ""}
									{member.expiresAt ? `有效期至 ${new Date(member.expiresAt).toLocaleString()}` : "未设置有效期"}
								</small>
							</div>
							{member.id !== selfId && (
								<div className="member-ledger-actions">
									<button
										type="button"
										className="avant-btn avant-btn-xs avant-btn-secondary"
										disabled={busy}
										onClick={() => open("rename", member)}
									>
										<Pencil size={11} />
										改名
									</button>
									{!member.revokedAt && (
										<>
											<button
												type="button"
												className="avant-btn avant-btn-xs avant-btn-secondary"
												disabled={busy}
												onClick={() => open("rotate", member)}
											>
												<KeyRound size={11} />
												轮换与授权
											</button>
											{member.bannedAt ? (
												<button
													type="button"
													className="avant-btn avant-btn-xs avant-btn-secondary"
													disabled={busy}
													onClick={() => void send({ action: "unban", id: member.id })}
												>
													<ShieldCheck size={11} />
													解封
												</button>
											) : (
												<button
													type="button"
													className="avant-btn avant-btn-xs avant-btn-secondary danger-hover"
													disabled={busy}
													onClick={() => open("ban", member)}
												>
													<Ban size={11} />
													封禁
												</button>
											)}
											<button
												type="button"
												className="avant-btn avant-btn-xs avant-btn-secondary danger-hover"
												disabled={busy}
												onClick={() => void send({ action: "revoke", id: member.id })}
											>
												<ShieldOff size={11} />
												撤销凭据
											</button>
										</>
									)}
									{member.revokedAt && (
										<button
											type="button"
											className="avant-btn avant-btn-xs avant-btn-danger"
											disabled={busy}
											onClick={() => void send({ action: "delete", id: member.id })}
										>
											<Trash2 size={11} />
											删除已撤销成员
										</button>
									)}
								</div>
							)}
						</article>
					);
				})}
			</div>
			{editing && (
				<AccessibleModal
					title={
						{ create: "创建团队成员", rotate: "轮换凭据与更新授权", rename: "修改成员名称", ban: "封禁成员" }[
							editing.action
						]
					}
					onClose={() => setEditing(undefined)}
					maxWidth={680}
				>
					{editing.action === "ban" ? (
						<label className="collab-field">
							<span>
								<Ban size={12} /> 封禁原因
							</span>
							<textarea
								className="avant-input"
								value={reason}
								onChange={(event) => setReason(event.target.value)}
								maxLength={1000}
							/>
						</label>
					) : (
						<label className="collab-field">
							<span>
								<UserCheck size={12} /> 成员名称
							</span>
							<input
								className="avant-input"
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={120}
							/>
						</label>
					)}
					{(editing.action === "create" || editing.action === "rotate") && (
						<>
							<fieldset className="member-fieldset">
								<legend>角色</legend>
								<div className="role-selector-chips">
									{(["reader", "contributor", "reviewer", "admin"] as TeamRole[]).map((role) => (
										<button
											key={role}
											type="button"
											className={`role-select-chip ${roles.includes(role) ? "active" : ""}`}
											aria-pressed={roles.includes(role)}
											onClick={() =>
												setRoles((previous) =>
													previous.includes(role)
														? previous.filter((value) => value !== role)
														: [...previous, role],
												)
											}
										>
											{role}
										</button>
									))}
								</div>
							</fieldset>
							<label className="collab-field">
								<span>
									<Users size={12} /> 授权空间（逗号分隔）
								</span>
								<input
									className="avant-input"
									value={namespaces}
									onChange={(event) => setNamespaces(event.target.value)}
									placeholder="lab, security"
								/>
							</label>
							<label className="collab-field">
								<span>
									<RotateCcw size={12} /> 有效期（留空表示无到期日）
								</span>
								<input
									className="avant-input"
									type="datetime-local"
									value={expires}
									onChange={(event) => setExpires(event.target.value)}
								/>
							</label>
							{editing.action === "rotate" && (
								<p className="collab-message">旧接入串将立即失效。执行后请复制新接入串并交给对应成员。</p>
							)}
						</>
					)}
					<div className="modal-actions">
						<button type="button" className="avant-btn avant-btn-secondary" onClick={() => setEditing(undefined)}>
							取消
						</button>
						<button
							type="button"
							className="avant-btn avant-btn-primary"
							disabled={
								busy ||
								(editing.action !== "ban" && !name.trim()) ||
								((editing.action === "create" || editing.action === "rotate") &&
									(!roles.length || (!roles.includes("admin") && !namespaces.trim())))
							}
							onClick={submit}
						>
							<KeyRound size={14} />
							预览成员操作
						</button>
					</div>
				</AccessibleModal>
			)}
		</div>
	);
}
