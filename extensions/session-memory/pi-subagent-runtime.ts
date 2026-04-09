import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SubagentUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface RunPiSubagentOptions {
	cwd: string;
	prompt: string;
	model?: string;
	tools?: string[];
	signal?: AbortSignal;
	systemPrompt?: string;
	hiddenContext?: string;
	hiddenContextType?: string;
	extraExtensions?: string[];
	env?: Record<string, string>;
}

export interface PiSubagentRunResult {
	exitCode: number;
	messages: Array<{ role?: string; content?: unknown }>;
	stderr: string;
	usage: SubagentUsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

type RunPiSubagentModule = {
	runPiSubagent(options: RunPiSubagentOptions): Promise<PiSubagentRunResult>;
};

let runtimePromise: Promise<RunPiSubagentModule> | null = null;

export async function runPiSubagent(options: RunPiSubagentOptions): Promise<PiSubagentRunResult> {
	const runtime = await loadRuntime();
	return runtime.runPiSubagent(options);
}

async function loadRuntime(): Promise<RunPiSubagentModule> {
	if (!runtimePromise) {
		runtimePromise = resolveRuntimeModule();
	}
	return runtimePromise;
}

async function resolveRuntimeModule(): Promise<RunPiSubagentModule> {
	const runtimePath = await findRuntimePath();
	if (!runtimePath) {
		throw new Error(
			"pi-subagent-tool is required but was not found in the installed Pi packages or local monorepo packages. Install it with `pi install git:github.com/san-tian/pi-subagent-tool`.",
		);
	}

	return (await import(pathToFileURL(runtimePath).href)) as RunPiSubagentModule;
}

async function findRuntimePath(): Promise<string | null> {
	for (const candidate of getCandidateRuntimePaths()) {
		if (await exists(candidate)) {
			return candidate;
		}
	}
	return null;
}

function getCandidateRuntimePaths(): string[] {
	const candidates = new Set<string>();

	const localPackage = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../../pi-subagent-tool/extensions/subagent/runtime.ts",
	);
	candidates.add(localPackage);

	const cwdCandidates = collectAncestorPackageCandidates(process.cwd());
	for (const candidate of cwdCandidates) {
		candidates.add(candidate);
	}

	const packagesRoot = getPiPackagesRoot();
	candidates.add(path.join(packagesRoot, "san-tian", "pi-subagent-tool", "extensions", "subagent", "runtime.ts"));

	return [...candidates];
}

function collectAncestorPackageCandidates(startDir: string): string[] {
	const candidates: string[] = [];
	let current = path.resolve(startDir);
	let previous = "";

	while (current !== previous) {
		candidates.push(path.join(current, "packages", "pi-subagent-tool", "extensions", "subagent", "runtime.ts"));
		previous = current;
		current = path.dirname(current);
	}

	return candidates;
}

function getPiPackagesRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "git", "github.com");
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
