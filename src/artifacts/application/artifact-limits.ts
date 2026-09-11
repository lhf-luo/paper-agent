export const DEFAULT_ARTIFACT_MEGABYTES = 200;
export const MAX_ARTIFACT_MEGABYTES = 500;
export const MAX_ARTIFACT_BYTES = MAX_ARTIFACT_MEGABYTES * 1024 * 1024;

export function artifactByteLimit(megabytes = DEFAULT_ARTIFACT_MEGABYTES): number {
	if (!Number.isInteger(megabytes) || megabytes < 1 || megabytes > MAX_ARTIFACT_MEGABYTES) {
		throw new Error(`maxMegabytesPerArtifact must be an integer between 1 and ${MAX_ARTIFACT_MEGABYTES}`);
	}
	return megabytes * 1024 * 1024;
}

export function validateArtifactByteLimit(bytes: number): number {
	if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ARTIFACT_BYTES) {
		throw new Error(`maxBytesPerArtifact must be an integer between 1 and ${MAX_ARTIFACT_BYTES}`);
	}
	return bytes;
}
