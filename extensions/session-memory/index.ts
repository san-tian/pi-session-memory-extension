import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { runPiSubagent } from "pi-subagent-tool/extensions/subagent/runtime";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

import {
	buildSessionMemoryUpdatePrompt,
	DEFAULT_SESSION_MEMORY_TEMPLATE,
	isSessionMemoryEmpty,
	loadSessionMemoryTemplate,
	truncateSessionMemoryForCompact,
} from "./prompts";

const STATE_ENTRY_TYPE = "session-memory-state";
const REPORT_MESSAGE_TYPE = "session-memory-report";
const ACTIVE_UPDATE_WAIT_TIMEOUT_MS = 15000;
const ACTIVE_UPDATE_WAIT_INTERVAL_MS = 200;

const DEFAULT_CONFIG = {
	minimumMessageTokensToInit: 10000,
	minimumTokensBetweenUpdate: 5000,
	toolCallsBetweenUpdates: 3,
};

const COMPACT_CONFIG = {
	minTokens: 10000,
	minTextEntries: 5,
	maxTokens: 40000,
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
	reason: "auto" | "manual";
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
		await waitForActiveUpdate(ctx);

		const notesPath = getNotesPath(ctx);
		if (!(await fileExists(notesPath))) {
			return;
		}

		const notesContent = await fs.readFile(notesPath, "utf8");
		if (await isSessionMemoryEmpty(notesContent)) {
			return;
		}

		const { truncatedContent } = truncateSessionMemoryForCompact(notesContent);
		const state = getState(ctx);
		const firstKeptEntryId = deriveFirstKeptEntryId(
			event.branchEntries,
			event.preparation.firstKeptEntryId,
			state.lastSummarizedEntryId,
		);

		return {
			compaction: {
				summary: truncatedContent,
				firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					source: "session-memory",
					notesPath,
					lastSummarizedEntryId: state.lastSummarizedEntryId,
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
					`- Update running: ${activeUpdates.has(getSessionKey(ctx))}`,
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
	return path.join(
		homedir(),
		".pi",
		"projects",
		sanitizeProjectPath(ctx.sessionManager.getCwd()),
		ctx.sessionManager.getSessionId(),
		"session-memory",
	);
}

function getNotesPath(ctx: ExtensionContext): string {
	return path.join(getNotesDir(ctx), "summary.md");
}

function getLegacyNotesPath(ctx: ExtensionContext): string {
	return path.join(ctx.sessionManager.getCwd(), ".pi", "session-memory", ctx.sessionManager.getSessionId(), "summary.md");
}

async function ensureMemoryFile(ctx: ExtensionContext): Promise<{ notesPath: string; currentNotes: string; template: string }> {
	const notesPath = getNotesPath(ctx);
	const legacyNotesPath = getLegacyNotesPath(ctx);
	const template = await loadSessionMemoryTemplate();
	await fs.mkdir(path.dirname(notesPath), { recursive: true });
	if (!(await fileExists(notesPath)) && (await fileExists(legacyNotesPath))) {
		await fs.copyFile(legacyNotesPath, notesPath);
	}
	if (!(await fileExists(notesPath))) {
		await fs.writeFile(notesPath, template, "utf8");
	}
	const currentNotes = await fs.readFile(notesPath, "utf8");
	return { notesPath, currentNotes, template };
}

function sanitizeProjectPath(cwd: string): string {
	return cwd
		.replace(/^[A-Za-z]:/, (match) => match[0].toLowerCase())
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "root";
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
		const conversationText = serializeConversation(convertToLlm(context.messages));
		const prompt = await buildSessionMemoryUpdatePrompt(currentNotes, notesPath);
		const model = resolveModel(ctx);
		if (!model) {
			return { ok: false, error: "No model available for session memory extraction" };
		}

		const result = await runPiSubagent({
			cwd: ctx.cwd,
			prompt,
			model: formatCliModel(model),
			tools: ["edit"],
			signal: ctx.signal,
			systemPrompt: ctx.getSystemPrompt(),
			hiddenContext: conversationText,
			hiddenContextType: "session-memory-context",
		});

		if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
			return {
				ok: false,
				error: formatSubagentError(result),
			};
		}

		const nextNotes = sanitizeNotes(await fs.readFile(notesPath, "utf8"));
		if (!matchesTemplateStructure(nextNotes, template)) {
			return { ok: false, error: "Subagent output did not preserve the session memory template structure" };
		}

		const tokenCount = ctx.getContextUsage()?.tokens ?? roughTokenCount(conversationText);
		const nextState: SessionMemoryState = {
			initialized: true,
			tokensAtLastExtraction: tokenCount,
			lastTriggerEntryId: ctx.sessionManager.getLeafId() ?? state.lastTriggerEntryId,
			lastSummarizedEntryId: ctx.sessionManager.getLeafId() ?? state.lastSummarizedEntryId,
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

function formatCliModel(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function formatSubagentError(result: {
	stderr: string;
	errorMessage?: string;
	messages: Array<{ role?: string; content?: unknown }>;
	stopReason?: string;
}): string {
	if (result.errorMessage) {
		return result.errorMessage;
	}
	const lastAssistantText = getLastAssistantText(result.messages);
	if (lastAssistantText) {
		return lastAssistantText;
	}
	if (result.stderr.trim()) {
		return result.stderr.trim();
	}
	return result.stopReason ? `Subagent stopped: ${result.stopReason}` : "Subagent failed";
}

function getLastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		const text = message.content
			.filter((part): part is { type: string; text?: string } => Boolean(part) && typeof part === "object")
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text ?? "")
			.join("\n")
			.trim();
		if (text) {
			return text;
		}
	}
	return "";
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

function deriveFirstKeptEntryId(entries: SessionEntry[], defaultEntryId: string, lastSummarizedEntryId?: string): string {
	const defaultIndex = entries.findIndex((entry) => entry.id === defaultEntryId);
	if (defaultIndex === -1) {
		return defaultEntryId;
	}

	let startIndex = entries.length;
	if (lastSummarizedEntryId) {
		const summarizedIndex = entries.findIndex((entry) => entry.id === lastSummarizedEntryId);
		if (summarizedIndex !== -1) {
			startIndex = Math.min(entries.length, summarizedIndex + 1);
		}
	}

	startIndex = expandStartIndexForRecentContext(entries, startIndex, defaultIndex);
	startIndex = adjustStartIndexToPreserveToolGroups(entries, startIndex, defaultIndex);

	return entries[startIndex]?.id ?? defaultEntryId;
}

function expandStartIndexForRecentContext(entries: SessionEntry[], startIndex: number, floorIndex: number): number {
	if (entries.length === 0) {
		return 0;
	}

	let nextStart = Math.max(Math.min(startIndex, entries.length), floorIndex);
	let totalTokens = 0;
	let textEntryCount = 0;

	for (let index = nextStart; index < entries.length; index += 1) {
		totalTokens += estimateEntryTokens(entries[index]);
		if (entryHasText(entries[index])) {
			textEntryCount += 1;
		}
	}

	if (totalTokens >= COMPACT_CONFIG.maxTokens) {
		return nextStart;
	}

	if (totalTokens >= COMPACT_CONFIG.minTokens && textEntryCount >= COMPACT_CONFIG.minTextEntries) {
		return nextStart;
	}

	for (let index = nextStart - 1; index >= floorIndex; index -= 1) {
		totalTokens += estimateEntryTokens(entries[index]);
		if (entryHasText(entries[index])) {
			textEntryCount += 1;
		}
		nextStart = index;

		if (totalTokens >= COMPACT_CONFIG.maxTokens) {
			break;
		}

		if (totalTokens >= COMPACT_CONFIG.minTokens && textEntryCount >= COMPACT_CONFIG.minTextEntries) {
			break;
		}
	}

	return nextStart;
}

function adjustStartIndexToPreserveToolGroups(entries: SessionEntry[], startIndex: number, floorIndex: number): number {
	let nextStart = startIndex;
	while (nextStart > floorIndex && isToolResultEntry(entries[nextStart])) {
		nextStart -= 1;
	}

	if (nextStart > floorIndex && isAssistantToolCallEntry(entries[nextStart - 1]) && isToolResultEntry(entries[nextStart])) {
		nextStart -= 1;
	}

	return nextStart;
}

function estimateEntryTokens(entry: SessionEntry | undefined): number {
	if (!entry) {
		return 0;
	}
	if (entry.type === "message") {
		return roughTokenCount(extractMessageText(entry.message));
	}
	if (entry.type === "custom_message") {
		return roughTokenCount(extractContentText(entry.content));
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return roughTokenCount(entry.summary);
	}
	return 0;
}

function entryHasText(entry: SessionEntry | undefined): boolean {
	if (!entry) {
		return false;
	}
	if (entry.type === "message") {
		if (entry.message.role !== "assistant" && entry.message.role !== "user") {
			return false;
		}
		return extractMessageText(entry.message).trim().length > 0;
	}
	if (entry.type === "custom_message") {
		return extractContentText(entry.content).trim().length > 0;
	}
	return false;
}

function extractMessageText(message: { content?: unknown }): string {
	return extractContentText(message.content);
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}
		const block = part as {
			type?: string;
			text?: string;
			name?: string;
			arguments?: unknown;
			content?: unknown;
		};
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if ((block.type === "toolCall" || block.type === "tool_use") && typeof block.name === "string") {
			parts.push(`tool:${block.name} ${JSON.stringify(block.arguments ?? {})}`);
			continue;
		}
		if ((block.type === "tool_result" || block.type === "toolResult") && block.content !== undefined) {
			parts.push(extractContentText(block.content));
		}
	}
	return parts.join("\n");
}

function isToolResultEntry(entry: SessionEntry | undefined): boolean {
	return Boolean(entry && entry.type === "message" && entry.message.role === "toolResult");
}

function isAssistantToolCallEntry(entry: SessionEntry | undefined): boolean {
	if (!entry || entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
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

function roughTokenCount(content: string): number {
	return Math.ceil(content.length / 4);
}

async function waitForActiveUpdate(ctx: ExtensionContext): Promise<void> {
	const key = getSessionKey(ctx);
	const startedAt = Date.now();
	while (activeUpdates.has(key)) {
		if (Date.now() - startedAt >= ACTIVE_UPDATE_WAIT_TIMEOUT_MS) {
			return;
		}
		await sleep(ACTIVE_UPDATE_WAIT_INTERVAL_MS);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
