export interface PiAuthPrompt {
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: readonly { id: string; label: string; description?: string }[];
}

export interface PiProviderView {
	id: string;
	name: string;
	configured: boolean;
	modelCount: number;
	apiKeyLogin: boolean;
	oauth: boolean;
	customized: boolean;
}

export interface PiModelView {
	key: string;
	providerId: string;
	modelId: string;
	name: string;
	baseUrl: string;
	api: string;
	input: ("text" | "image")[];
	credentialsAvailable: boolean;
}

export interface PiModelsView {
	directory: string;
	error?: string;
	providers: PiProviderView[];
	models: PiModelView[];
	activeKey?: string;
}
