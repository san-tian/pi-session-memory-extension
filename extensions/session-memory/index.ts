import fs from "node:fs/promises";
import path from "node:path";

import { getPiProjectSubdir } from "@san-tian/pi-project-paths";
import { runPiSubagent } from "./pi-subagent-runtime";
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
} from "./prompts";

const STATE_ENTRY_TYPE = "session-memory-state";
const REPORT_MESSAGE_TYPE = "session-memory-report";
const _SESSION_MEMORY_SUBAGENT_ENV = "_PI_SESSION_MEMORY_SUBAGENT";
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

type NotesSection = {
	header: string;
	description: string;
	body: string;
};

type NotesRepairResult = {
	ok: boolean;
	content: string;
	repaired: boolean;
	diagnostics: string[];
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
		if (isSessionMemorySubagentProcess()) {
			return;
		}
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


	pi.registerCommand("session-memory-update", {
		description: "Force a Claude-style session memory refresh",
		handler: async (_args, ctx) => {
			if (isSessionMemorySubagentProcess()) {
				ctx.ui.notify("Session memory update is disabled inside the internal session-memory subagent", "warning");
				return;
			}
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
	return getPiProjectSubdir(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionId(), "session-memory");
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
		const preparedNotes = repairNotesToTemplate(currentNotes, template);
		if (!preparedNotes.ok) {
			return {
				ok: false,
				error: `Current session memory file drifted out of template shape: ${formatNotesRepairDiagnostics(preparedNotes.diagnostics)}`,
			};
		}
		if (preparedNotes.repaired) {
			await fs.writeFile(notesPath, preparedNotes.content, "utf8");
		}

		const conversationText = serializeConversation(convertToLlm(context.messages));
		const prompt = await buildSessionMemoryUpdatePrompt(preparedNotes.content, notesPath);
		const model = resolveModel(ctx);
		if (!model) {
			return { ok: false, error: "No model available for session memory extraction" };
		}

		const result = await runPiSubagent({
			cwd: ctx.cwd,
			prompt,
			model: formatSubagentModelSpec(model),
			tools: ["edit"],
			signal: ctx.signal,
			systemPrompt: ctx.getSystemPrompt(),
			hiddenContext: conversationText,
			hiddenContextType: "session-memory-context",
			env: {
				[_SESSION_MEMORY_SUBAGENT_ENV]: "1",
			},
		});

		if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
			return {
				ok: false,
				error: formatSubagentError(result),
			};
		}

		const nextNotesResult = repairNotesToTemplate(await fs.readFile(notesPath, "utf8"), template);
		if (!nextNotesResult.ok) {
			return {
				ok: false,
				error: `Subagent output did not preserve the session memory template structure: ${formatNotesRepairDiagnostics(nextNotesResult.diagnostics)}`,
			};
		}
		if (nextNotesResult.repaired) {
			await fs.writeFile(notesPath, nextNotesResult.content, "utf8");
		}
		const nextNotes = nextNotesResult.content;

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
			ctx.ui.notify("Session memory updated", "info");
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

function formatSubagentModelSpec(model: { provider: string; id: string; reasoning?: boolean }): string {
	const base = `${model.provider}/${model.id}`;
	if (!model.reasoning) {
		return base;
	}

	// Use an explicit low reasoning level so the subagent does not inherit a session/project
	// default like `minimal`, which some OpenAI reasoning models reject.
	return `${base}:low`;
}

function isSessionMemorySubagentProcess(): boolean {
	return process.env[_SESSION_MEMORY_SUBAGENT_ENV] === "1";
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

function repairNotesToTemplate(content: string, template: string): NotesRepairResult {
	const sanitizedContent = sanitizeNotes(content);
	const templateSections = parseNotesSections(template);
	if (templateSections.length === 0) {
		return {
			ok: false,
			content: sanitizedContent,
			repaired: false,
			diagnostics: ["Session memory template has no recognizable '# ' section headers"],
		};
	}

	const actualSections = parseNotesSections(sanitizedContent);
	if (actualSections.length === 0) {
		return {
			ok: false,
			content: sanitizedContent,
			repaired: false,
			diagnostics: [
				sanitizedContent
					? "No recognizable '# ' section headers found in the session memory file"
					: "Session memory file became empty",
			],
		};
	}

	const diagnostics: string[] = [];
	const rendered = renderNotesFromTemplate(templateSections, actualSections, diagnostics);
	return {
		ok: true,
		content: rendered,
		repaired: rendered !== sanitizedContent,
		diagnostics,
	};
}

function parseNotesSections(content: string): NotesSection[] {
	const lines = sanitizeNotes(content).split("\n");
	const sections: NotesSection[] = [];
	let currentHeader: string | undefined;
	let currentLines: string[] = [];

	const flushSection = () => {
		if (!currentHeader) {
			return;
		}
		let cursor = 0;
		while (cursor < currentLines.length && currentLines[cursor].trim() === "") {
			cursor += 1;
		}
		let description = "";
		if (cursor < currentLines.length && /^_.*_$/.test(currentLines[cursor])) {
			description = currentLines[cursor];
			cursor += 1;
		}
		const body = trimBlankLines(currentLines.slice(cursor)).join("\n");
		sections.push({
			header: currentHeader,
			description,
			body,
		});
		currentHeader = undefined;
		currentLines = [];
	};

	for (const line of lines) {
		if (line.startsWith("# ")) {
			flushSection();
			currentHeader = line;
			currentLines = [];
			continue;
		}
		if (!currentHeader) {
			continue;
		}
		currentLines.push(line);
	}

	flushSection();
	return sections;
}

function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") {
		start += 1;
	}
	while (end > start && lines[end - 1].trim() === "") {
		end -= 1;
	}
	return lines.slice(start, end);
}

function renderNotesFromTemplate(templateSections: NotesSection[], actualSections: NotesSection[], diagnostics: string[]): string {
	const unusedIndexes = new Set(actualSections.map((_, index) => index));
	const bodies = templateSections.map((templateSection, index) => {
		const matchedIndex = findSectionMatch(templateSection, actualSections, unusedIndexes, index);
		if (matchedIndex === -1) {
			diagnostics.push(`Missing section ${templateSection.header}; restored an empty body`);
			return "";
		}

		unusedIndexes.delete(matchedIndex);
		const actualSection = actualSections[matchedIndex];
		if (actualSection.header !== templateSection.header) {
			diagnostics.push(
				`Recovered ${templateSection.header} from section position ${matchedIndex + 1} (${actualSection.header})`,
			);
		}
		if (templateSection.description && actualSection.description !== templateSection.description) {
			diagnostics.push(`Restored the template guidance line under ${templateSection.header}`);
		}
		return actualSection.body;
	});

	for (const unusedIndex of unusedIndexes) {
		diagnostics.push(`Ignored extra section ${actualSections[unusedIndex]?.header ?? `#${unusedIndex + 1}`}`);
	}

	const renderedLines: string[] = [];
	for (const [index, section] of templateSections.entries()) {
		if (index > 0) {
			renderedLines.push("");
		}
		renderedLines.push(section.header);
		if (section.description) {
			renderedLines.push(section.description);
		}
		renderedLines.push("");
		if (bodies[index]) {
			renderedLines.push(bodies[index]);
		}
	}

	return renderedLines.join("\n").trimEnd();
}

function findSectionMatch(
	templateSection: NotesSection,
	actualSections: NotesSection[],
	unusedIndexes: Set<number>,
	fallbackIndex: number,
): number {
	for (const index of unusedIndexes) {
		if (actualSections[index]?.header === templateSection.header) {
			return index;
		}
	}
	if (unusedIndexes.has(fallbackIndex)) {
		return fallbackIndex;
	}
	return -1;
}

function formatNotesRepairDiagnostics(diagnostics: string[]): string {
	if (diagnostics.length === 0) {
		return "structure drift could not be repaired";
	}
	return diagnostics.slice(0, 3).join("; ");
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
