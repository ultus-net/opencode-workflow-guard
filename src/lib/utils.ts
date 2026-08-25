import { getSdkClient } from "./state.ts";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function extractRecordTargetPath(input: unknown): string | undefined {
	const record = asRecord(input);
	if (typeof record?.filePath === "string") return record.filePath;
	if (typeof record?.path === "string") return record.path;
	return undefined;
}

export function extractTargetPath(input: unknown): string | undefined {
	return extractRecordTargetPath(input) ?? (typeof input === "string" ? input : undefined);
}

export const SENSITIVE_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_KEY", "KUBECONFIG", "NPM_TOKEN", "DOCKER_AUTH", "GOOGLE_APPLICATION_CREDENTIALS", "GCLOUD_AUTH", "AZURE_CREDENTIALS", "SLACK_TOKEN"];
export const SENSITIVE_ENV_RE = /^(AWS_|KUBE|OPENAI|ANTHROPIC|GOOGLE_|GCP_|AZURE_|SLACK_|NPM_|DOCKER_|KUBECONFIG)/;

export function isSensitiveEnvKey(key: string): boolean {
	return SENSITIVE_ENV_KEYS.includes(key) || SENSITIVE_ENV_RE.test(key);
}

export function getCleanEnv(): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	for (const key of Object.keys(env)) {
		if (isSensitiveEnvKey(key)) delete env[key];
	}
	return env;
}

export async function showBlockToast(message: string): Promise<void> {
	try {
		const client = getSdkClient();
		await client?.tui?.showToast?.({ body: { title: "Workflow Guard Blocked", message: message.slice(0, 180), variant: "warning" } });
	} catch {}
}
