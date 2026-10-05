// THE TRANSCRIPT MIRRORS THE MODEL'S WINDOW (2026-10-04).
//
// Pi paints the chat from raw session entries and walks every component on every frame,
// and only a native compaction ever clears it. pi-fold cancels native compaction, so the
// chat grew for the whole life of a session: 16,218 entries painted per frame on
// session 01a10161. The model, meanwhile, sees each fold as one placeholder.
//
// The chat now shows what the model sees: every fold the model holds collapsed becomes
// ONE row, and the components it covers leave the chat until the model expands it.
// Read-only and one-way, as in memex's applyTranscriptFolds: the model's structure moves
// the view, nothing in the view moves the model. Pi gives an extension no transcript API,
// so this edits Pi's chat container in place. It never builds a message component: the
// rows Pi painted stay Pi's own objects, live references and all, and the ones a fold
// covers are held by its row so an expansion hands them back unchanged.

import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Spacer, truncateToWidth } from "@earendil-works/pi-tui";

export interface MirrorFold {
	id: string;
	kind: string;
	brief: string;
	sourceCount: number;
	/** Every session entry the fold covers, nested folds included. */
	entryIds: string[];
}

interface ChatContainer {
	children: unknown[];
}

/** One collapsed fold in the chat. Holds the components it covers, in order. */
export class FoldRow {
	readonly foldId: string;
	readonly hidden: unknown[] = [];
	private readonly text: string;
	private readonly style: (text: string) => string;

	constructor(fold: MirrorFold, style: (text: string) => string) {
		this.foldId = fold.id;
		this.style = style;
		const [head] = fold.brief.split("\n").map((line) => line.trim()).filter(Boolean);
		const count = `${fold.sourceCount} ${fold.sourceCount === 1 ? "entry" : "entries"}`;
		this.text = `\u25b8 ${fold.kind ? `${fold.kind} · ` : ""}${count}${head ? ` · ${head}` : ""}`;
	}

	render(width: number): string[] {
		return ["", this.style(truncateToWidth(` ${this.text}`, Math.max(1, width)))];
	}

	invalidate(): void { }
}

/** Pi's chat container: the container holding the most message components directly.
 *  Pi moves the same container between its regular and fullscreen hosts, so it is found
 *  once. Null until the chat holds a message, which is before any fold exists. */
export function locateChatContainer(root: unknown): ChatContainer | null {
	let best: ChatContainer | null = null;
	let bestCount = 0;
	const seen = new Set<unknown>();
	const visit = (node: unknown, depth: number): void => {
		const children = (node as { children?: unknown })?.children;
		if (depth > 4 || seen.has(node) || !Array.isArray(children)) return;
		seen.add(node);
		let count = 0;
		for (const child of children) {
			// A message component's own parts are never the chat: do not descend into one.
			if (anchorKind(child) !== null) count += 1;
			else visit(child, depth + 1);
		}
		if (count > bestCount) { best = node as ChatContainer; bestCount = count; }
	};
	visit(root, 0);
	return best;
}

function anchorKind(component: unknown): "assistant" | "tool" | "user" | "custom" | null {
	if (component instanceof AssistantMessageComponent) return "assistant";
	if (component instanceof ToolExecutionComponent) return "tool";
	if (component instanceof UserMessageComponent) return "user";
	if (component instanceof CustomMessageComponent) return "custom";
	return null;
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("");
}

/** What a component shows, in the terms its session entry can be found by. */
function componentSignature(component: unknown): string | null {
	const any = component as Record<string, any>;
	switch (anchorKind(component)) {
		case "assistant": return `a:${any.lastMessage?.timestamp}`;
		case "user": return `u:${any.text}`;
		case "custom": return `c:${any.message?.customType}`;
		default: return null;
	}
}

/**
 * Which session entry painted each chat component. Anchors are found by what they show:
 * an assistant message by its timestamp, a tool call by its call id, a user message by
 * its text and a custom message by its type, each searched FORWARD from the last match so
 * a repeated text binds to the right occurrence. Everything else (spacers, notices)
 * belongs to its neighbour: a run of spacers directly before an anchor leads that anchor,
 * anything else trails the anchor before it. Unowned components are never folded.
 */
export function chatOwners(children: unknown[], branch: any[]): Array<string | null> {
	const positions = new Map<string, number[]>();
	const callOwner = new Map<string, number>();
	branch.forEach((entry, index) => {
		const message = entry?.type === "message" ? entry.message : null;
		let signature: string | null = null;
		if (message?.role === "assistant") {
			signature = `a:${message.timestamp}`;
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part?.type === "toolCall" && typeof part.id === "string") callOwner.set(part.id, index);
			}
		} else if (message?.role === "user") signature = `u:${userText(message.content)}`;
		else if (entry?.type === "custom_message") signature = `c:${entry.customType}`;
		if (signature === null) return;
		const list = positions.get(signature);
		if (list) list.push(index); else positions.set(signature, [index]);
	});
	const nextAt = (signature: string, from: number): number => {
		const list = positions.get(signature);
		if (!list) return -1;
		let low = 0;
		let high = list.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (list[mid] < from) low = mid + 1; else high = mid;
		}
		return low < list.length ? list[low] : -1;
	};

	const owners: Array<string | null> = new Array(children.length).fill(null);
	let cursor = 0;
	let previous: string | null = null;
	let pending: number[] = [];
	const settle = (lead: string | null): void => {
		// Spacers immediately before an anchor lead it; the rest trail the previous anchor.
		let split = pending.length;
		while (split > 0 && children[pending[split - 1]] instanceof Spacer) split -= 1;
		for (let i = 0; i < pending.length; i += 1) owners[pending[i]] = i < split ? previous : lead;
		pending = [];
	};
	children.forEach((component, index) => {
		let at = -1;
		if (component instanceof ToolExecutionComponent) {
			at = callOwner.get(String((component as unknown as { toolCallId: unknown }).toolCallId)) ?? -1;
		} else {
			const signature = componentSignature(component);
			if (signature === null) { pending.push(index); return; }
			at = nextAt(signature, cursor);
		}
		const owner = at >= 0 && typeof branch[at]?.id === "string" ? branch[at].id as string : null;
		settle(owner);
		owners[index] = owner;
		if (at >= 0) cursor = Math.max(cursor, at);
		previous = owner;
	});
	settle(previous);
	return owners;
}

/** Hand every row's components back, in place: the chat as Pi painted it. */
export function unfoldedChildren(children: unknown[]): unknown[] {
	return children.flatMap((child) => child instanceof FoldRow ? child.hidden : [child]);
}

/** The chat with each collapsed fold reduced to its row. A fold none of whose entries
 *  are on screen gets no row. */
export function foldedChildren(
	children: unknown[],
	branch: any[],
	folds: MirrorFold[],
	style: (text: string) => string,
): unknown[] {
	const raw = unfoldedChildren(children);
	if (!folds.length) return raw;
	const foldOf = new Map<string, MirrorFold>();
	for (const fold of folds) for (const entryId of fold.entryIds) foldOf.set(entryId, fold);
	const owners = chatOwners(raw, branch);
	const rows = new Map<string, FoldRow>();
	const output: unknown[] = [];
	raw.forEach((component, index) => {
		const owner = owners[index];
		const fold = owner === null ? undefined : foldOf.get(owner);
		if (!fold) { output.push(component); return; }
		let row = rows.get(fold.id);
		if (!row) {
			row = new FoldRow(fold, style);
			rows.set(fold.id, row);
			output.push(row);
		}
		row.hidden.push(component);
	});
	return output;
}
