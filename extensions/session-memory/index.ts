import fs from "node:fs/promises";
import path from "node:path";

import { complete } from "@mariozechner/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

import {
	buildSessionMemoryCompactionPrompt,
	buildSessionMemoryUpdatePrompt,
	DEFAULT_SESSION_MEMORY_TEMPLATE,
	isSessionMemoryEmpty,
	loadSessionMemoryTemplate,
	truncateSessionMemoryForCompact,
} from "./prompts";

const STATE_ENTRY_TYPE = "session-memory-state";
const REPORT_MESSAGE_TYPE = "session-memory-report";

const DEFAULT_CONFIG = {
	minimumMessageTokensToInit: 10000,
	minimumTokensBetweenUpdate: 5000,
	toolCallsBetweenUpdates: 3,
};

type SessionMemoryState = {
	initialized: boolean;
	tokensAtLastExtraction: number;
	lastTriggerEntryId?: string;
	lastSummarizedEntryId?: string;
	updatedAt?: string;
	notesPath?: string;
};

type UpdateOptions = {
	force: boolean;
	reason: "auto" | "manual" | "compact";
	conversationText?: string;
};

type UpdateResult = {
	ok: boolean;
	skipped?: string;
	error?: string;
	notesPath?: string;
	notesContent?: string;
	state?: SessionMemoryState;
};

const states = new Map<string, SessionMemoryState>();
const activeUpdates = new Set<string>();

const defaultState = (): SessionMemoryState => ({
	initialized: false,
	tokensAtLastExtraction: 0,
});

export default function sessionMemoryExtension(pi: ExtensionAPI) {
	const reconstructState = (ctx: ExtensionContext) => {
		states.set(getSessionKey(ctx), loadStateFromEntries(ctx.sessionManager.getEntries()));
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		states.delete(getSessionKey(ctx));
		activeUpdates.delete(getSessionKey(ctx));
	});

	pi.on("turn_end", async (event, ctx) => {
		const decision = getExtractionDecision(ctx);
		if (!decision.shouldExtract) {
			return;
		}

		const result = await updateSessionMemory(pi, ctx, {
			force: false,
			reason: "auto",
		});

		if (!result.ok && result.error && ctx.hasUI) {
			ctx.ui.notify(`Session memory update failed: ${result.error}`, "warning");
			return;
		}

		if (result.ok && ctx.hasUI && event.toolResults.length === 0) {
			ctx.ui.setStatus("session-memory", "Session memory updated");
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const result = await updateSessionMemory(pi, ctx, {
			force: true,
			reason: "compact",
			conversationText: serializeConversation(convertToLlm([
				...event.preparation.messagesToSummarize,
				...event.preparation.turnPrefixMessages,
			])),
		});

		if (!result.ok || !result.notesContent || !result.notesPath) {
			return;
		}

		if (await isSessionMemoryEmpty(result.notesContent)) {
			return;
		}

		const { truncatedContent } = truncateSessionMemoryForCompact(result.notesContent);

		return {
			compaction: {
				summary: truncatedContent,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					source: "session-memory",
					notesPath: result.notesPath,
				},
			},
		};
	});

	pi.registerCommand("session-memory-update", {
		description: "Force a Claude-style session memory refresh",
		handler: async (_args, ctx) => {
			const result = await updateSessionMemory(pi, ctx, {
				force: true,
				reason: "manual",
			});

			if (!result.ok) {
				ctx.ui.notify(result.error ?? result.skipped ?? "Session memory update skipped", "warning");
				return;
			}

			emitReport(
				pi,
				"Session Memory Updated",
				[`- Path: ${result.notesPath}`, `- Updated: ${result.state?.updatedAt ?? "unknown"}`].join("\n"),
			);
		},
	});

	pi.registerCommand("session-memory-status", {
		description: "Show the current session memory file and extraction state",
		handler: async (_args, ctx) => {
			const state = getState(ctx);
			const notesPath = getNotesPath(ctx);
			const exists = await fileExists(notesPath);
			const content = exists ? await fs.readFile(notesPath, "utf8") : DEFAULT_SESSION_MEMORY_TEMPLATE;
			const empty = await isSessionMemoryEmpty(content);
			emitReport(
				pi,
				"Session Memory Status",
				[
					`- Path: ${notesPath}`,
					`- Exists: ${exists}`,
					`- Initialized: ${state.initialized}`,
					`- Tokens at last extraction: ${state.tokensAtLastExtraction}`,
					`- Last trigger entry: ${state.lastTriggerEntryId ?? "(none)"}`,
					`- Last summarized entry: ${state.lastSummarizedEntryId ?? "(none)"}`,
					`- Updated at: ${state.updatedAt ?? "(never)"}`,
					`- Empty/template only: ${empty}`,
				].join("\n"),
			);
		},
	});
}

function loadStateFromEntries(entries: SessionEntry[]): SessionMemoryState {
	let state = defaultState();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !entry.data) {
			continue;
		}
		if (typeof entry.data === "object" && entry.data !== null) {
			state = {
				...state,
				...(entry.data as Partial<SessionMemoryState>),
			};
		}
	}
	return state;
}

function getSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `ephemeral:${ctx.sessionManager.getSessionId()}`;
}

function getState(ctx: ExtensionContext): SessionMemoryState {
	const key = getSessionKey(ctx);
	const existing = states.get(key);
	if (existing) {
		return existing;
	}
	const reconstructed = loadStateFromEntries(ctx.sessionManager.getEntries());
	states.set(key, reconstructed);
	return reconstructed;
}

function setState(pi: ExtensionAPI, ctx: ExtensionContext, next: SessionMemoryState): void {
	states.set(getSessionKey(ctx), next);
	pi.appendEntry(STATE_ENTRY_TYPE, next);
}

function getNotesDir(ctx: ExtensionContext): string {
	return path.join(ctx.sessionManager.getCwd(), ".pi", "session-memory", ctx.sessionManager.getSessionId());
}

function getNotesPath(ctx: ExtensionContext): string {
	return path.join(getNotesDir(ctx), "summary.md");
}

async function ensureMemoryFile(ctx: ExtensionContext): Promise<{ notesPath: string; currentNotes: string; template: string }> {
	const notesPath = getNotesPath(ctx);
	const template = await loadSessionMemoryTemplate();
	await fs.mkdir(path.dirname(notesPath), { recursive: true });
	if (!(await fileExists(notesPath))) {
		await fs.writeFile(notesPath, template, "utf8");
	}
	const currentNotes = await fs.readFile(notesPath, "utf8");
	return { notesPath, currentNotes, template };
}

function getExtractionDecision(ctx: ExtensionContext): { shouldExtract: boolean } {
	const state = getState(ctx);
	const entries = ctx.sessionManager.getBranch();
	const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const conversationText = serializeConversation(convertToLlm(context.messages));
	const tokenCount = ctx.getContextUsage()?.tokens ?? roughTokenCount(conversationText);

	if (!state.initialized && tokenCount < DEFAULT_CONFIG.minimumMessageTokensToInit) {
		return { shouldExtract: false };
	}

	const hasMetTokenThreshold = tokenCount - state.tokensAtLastExtraction >= DEFAULT_CONFIG.minimumTokensBetweenUpdate;
	if (!hasMetTokenThreshold) {
		return { shouldExtract: false };
	}

	const toolCallsSinceLastTrigger = countToolCallsSince(entries, state.lastTriggerEntryId);
	const hasMetToolCallThreshold = toolCallsSinceLastTrigger >= DEFAULT_CONFIG.toolCallsBetweenUpdates;
	const lastAssistantHasToolCalls = hasToolCallsInLastAssistantTurn(entries);

	return {
		shouldExtract: hasMetTokenThreshold && (hasMetToolCallThreshold || !lastAssistantHasToolCalls),
	};
}

function countToolCallsSince(entries: SessionEntry[], sinceEntryId?: string): number {
	let shouldCount = !sinceEntryId;
	let total = 0;

	for (const entry of entries) {
		if (!shouldCount) {
			if (entry.id === sinceEntryId) {
				shouldCount = true;
			}
			continue;
		}

		if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
			continue;
		}

		for (const part of entry.message.content) {
			if (!part || typeof part !== "object") {
				continue;
			}
			const block = part as { type?: string };
			if (block.type === "toolCall" || block.type === "tool_use") {
				total += 1;
			}
		}
	}

	return total;
}

function hasToolCallsInLastAssistantTurn(entries: SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || entry.type !== "message") {
			continue;
		}
		if (entry.message.role !== "assistant") {
			continue;
		}
		if (!Array.isArray(entry.message.content)) {
			return false;
		}
		return entry.message.content.some((part) => {
			if (!part || typeof part !== "object") {
				return false;
			}
			const block = part as { type?: string };
			return block.type === "toolCall" || block.type === "tool_use";
		});
	}
	return false;
}

function getLastAssistantEntryId(entries: SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return entry.id;
		}
	}
	return undefined;
}

async function updateSessionMemory(pi: ExtensionAPI, ctx: ExtensionContext, options: UpdateOptions): Promise<UpdateResult> {
	const key = getSessionKey(ctx);
	if (activeUpdates.has(key)) {
		return { ok: false, skipped: "Update already running" };
	}

	activeUpdates.add(key);
	try {
		const state = getState(ctx);
		const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		if (context.messages.length === 0) {
			return { ok: false, skipped: "No conversation to summarize" };
		}

		const { notesPath, currentNotes, template } = await ensureMemoryFile(ctx);
		const conversationText = options.conversationText ?? serializeConversation(convertToLlm(context.messages));
		const prompt = options.reason === "compact"
			? await buildSessionMemoryCompactionPrompt(currentNotes, notesPath, conversationText)
			: await buildSessionMemoryUpdatePrompt(currentNotes, notesPath, conversationText);
		const model = resolveModel(ctx);
		if (!model) {
			return { ok: false, error: "No model available for session memory extraction" };
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			return { ok: false, error: auth.error };
		}
		if (!auth.apiKey) {
			return { ok: false, error: `No API key for ${model.provider}/${model.id}` };
		}

		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 8192,
				signal: ctx.signal,
			},
		);

		const rawNotes = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();

		if (!rawNotes) {
			return { ok: false, error: "Model returned an empty session memory update" };
		}

		const nextNotes = sanitizeNotes(rawNotes);
		if (!matchesTemplateStructure(nextNotes, template)) {
			return { ok: false, error: "Model output did not preserve the session memory template structure" };
		}

		await fs.writeFile(notesPath, `${nextNotes.trimEnd()}\n`, "utf8");

		const tokenCount = ctx.getContextUsage()?.tokens ?? roughTokenCount(options.conversationText ?? conversationText);
		const nextState: SessionMemoryState = {
			initialized: true,
			tokensAtLastExtraction: tokenCount,
			lastTriggerEntryId: ctx.sessionManager.getLeafId() ?? state.lastTriggerEntryId,
			lastSummarizedEntryId: hasToolCallsInLastAssistantTurn(ctx.sessionManager.getBranch())
				? state.lastSummarizedEntryId
				: getLastAssistantEntryId(ctx.sessionManager.getBranch()) ?? state.lastSummarizedEntryId,
			updatedAt: new Date().toISOString(),
			notesPath,
		};
		setState(pi, ctx, nextState);

		if (options.reason === "manual" && ctx.hasUI) {
			ctx.ui.notify("Session memory updated", "success");
		}

		return {
			ok: true,
			notesPath,
			notesContent: nextNotes,
			state: nextState,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		activeUpdates.delete(key);
	}
}

function resolveModel(ctx: ExtensionContext) {
	return (
		ctx.model ??
		ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5") ??
		ctx.modelRegistry.find("openai", "gpt-5.2") ??
		ctx.modelRegistry.find("google", "gemini-2.5-flash")
	);
}

function sanitizeNotes(raw: string): string {
	let text = raw.trim();
	if (text.startsWith("```")) {
		text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
	}
	return text.replace(/\r\n/g, "\n");
}

function matchesTemplateStructure(content: string, template: string): boolean {
	const expected = extractTemplateMarkers(template);
	const actual = extractTemplateMarkers(content);
	if (expected.length !== actual.length) {
		return false;
	}
	return expected.every((marker, index) => marker === actual[index]);
}

function extractTemplateMarkers(content: string): string[] {
	return content
		.split("\n")
		.filter((line) => line.startsWith("# ") || (/^_.*_$/.test(line) && !line.includes("[... section truncated")));
}

function roughTokenCount(content: string): number {
	return Math.ceil(content.length / 4);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function emitReport(pi: ExtensionAPI, title: string, body: string): void {
	pi.sendMessage(
		{
			customType: REPORT_MESSAGE_TYPE,
			content: `## ${title}\n\n${body}`,
			display: true,
			details: { title, body },
		},
		{ triggerTurn: false },
	);
}
