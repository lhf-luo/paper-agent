/** Expected failures at the shared-content boundary, safe to return without internal paths. */
export class TeamStateError extends Error {
	readonly status: 400 | 403 | 404 | 409 | 413 | 428;

	constructor(status: 400 | 403 | 404 | 409 | 413 | 428, message: string) {
		super(message);
		this.status = status;
		this.name = "TeamStateError";
	}
}
