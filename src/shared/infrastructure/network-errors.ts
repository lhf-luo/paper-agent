export function readableErrorMessage(error: unknown): string {
	if (error instanceof AggregateError && error.errors.length > 0) {
		const first = error.errors[0];
		if (first instanceof Error && first.message) return first.message;
		if (first !== undefined && first !== null) return String(first);
	}
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}
