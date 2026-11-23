import type { gmail_v1 } from "googleapis";
import { type Mailbox, parseMailboxList } from "./json-format.js";

export type DraftAuditDisposition =
	| "likely_duplicate_sent"
	| "conflicting_obsolete_candidate"
	| "not_proven_duplicate"
	| "needs_human_decision";

export type SentMatchKind = "same_thread_sent" | "subject_and_recipient" | "subject_only" | "same_thread_earlier_sent";

export interface DraftAuditAttachment {
	filename: string;
	size: number;
	mime_type: string;
}

export interface SentDuplicateCandidate {
	message_id: string;
	thread_id: string | null;
	date: string | null;
	internal_date_ms: number | null;
	to: Mailbox[];
	cc: Mailbox[];
	subject: string | null;
	match_kind: SentMatchKind;
}

export interface DraftAuditItem {
	draft_id: string;
	message_id: string | null;
	thread_id: string | null;
	date: string | null;
	internal_date_ms: number | null;
	to: Mailbox[];
	cc: Mailbox[];
	subject: string | null;
	attachments: DraftAuditAttachment[];
	disposition: DraftAuditDisposition;
	reason: string;
	sent_candidates: SentDuplicateCandidate[];
	conflict_draft_ids: string[];
}

export interface DraftAuditSummary {
	total: number;
	likely_duplicate_sent: number;
	conflicting_obsolete_candidate: number;
	not_proven_duplicate: number;
	needs_human_decision: number;
}

export interface DraftAuditResult {
	account: string;
	older_than: string;
	check_sent: boolean;
	read_only: true;
	verification_note: string;
	summary: DraftAuditSummary;
	drafts: DraftAuditItem[];
}

export interface ParsedOlderThan {
	raw: string;
	cutoffMs: number | null;
	gmailQueryToken: string | null;
}

export const THREAD_VERIFICATION_NOTE =
	"Note: `gmcli thread` alone is not sufficient send verification because Gmail threads include DRAFT messages inline alongside sent messages. Verify sent status via `drafts audit --check-sent` or `in:sent`.";

const UNIT_MS: Record<string, number> = {
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
	m: 30 * 24 * 60 * 60 * 1000,
	y: 365 * 24 * 60 * 60 * 1000,
};

export function parseOlderThan(raw: string | undefined, nowMs = Date.now()): ParsedOlderThan {
	const trimmed = (raw ?? "1d").trim().toLowerCase();
	if (!trimmed || trimmed === "0" || trimmed === "all" || trimmed === "none") {
		return { raw: trimmed || "all", cutoffMs: null, gmailQueryToken: null };
	}

	const match = trimmed.match(/^(\d+)([hdwmy])$/);
	if (!match) {
		throw new Error(`Invalid --older-than value '${raw}'. Expected a duration like 1d, 12h, 2w, 1m, or 'all'.`);
	}

	const amount = Number(match[1]);
	const unit = match[2];
	if (amount === 0) {
		return { raw: trimmed, cutoffMs: null, gmailQueryToken: null };
	}

	const cutoffMs = nowMs - amount * UNIT_MS[unit];
	let gmailQueryToken: string | null = null;
	if (unit === "d" || unit === "m" || unit === "y") {
		gmailQueryToken = `older_than:${amount}${unit}`;
	} else if (unit === "w") {
		gmailQueryToken = `older_than:${amount * 7}d`;
	}
	// Hours ('h') are filtered client-side because Gmail's older_than: operator only supports d/m/y.

	return { raw: trimmed, cutoffMs, gmailQueryToken };
}

export function isSentMessage(message: Pick<gmail_v1.Schema$Message, "labelIds"> | null | undefined): boolean {
	const labels = message?.labelIds || [];
	return labels.includes("SENT") && !labels.includes("DRAFT");
}

export function extractEmailAddresses(mailboxes: Mailbox[]): string[] {
	const emails = new Set<string>();
	for (const box of mailboxes) {
		const email = box.email.trim().toLowerCase();
		if (email) emails.add(email);
	}
	return [...emails];
}

export function hasOverlappingRecipients(a: Mailbox[], b: Mailbox[]): boolean {
	const setA = new Set(extractEmailAddresses(a));
	if (setA.size === 0) return false;
	for (const email of extractEmailAddresses(b)) {
		if (setA.has(email)) return true;
	}
	return false;
}

export function buildSentSearchQuery(normalizedSubject: string, recipients: Mailbox[]): string | null {
	const emails = extractEmailAddresses(recipients);
	const cleanSubject = normalizedSubject.replace(/"/g, " ").replace(/\s+/g, " ").trim();
	if (!cleanSubject && emails.length === 0) return null;

	const parts = ["in:sent"];
	if (cleanSubject) {
		parts.push(`subject:"${cleanSubject}"`);
	}
	if (emails.length > 0) {
		parts.push(`to:${emails[0]}`);
	}
	return parts.join(" ");
}

export function parseMessageDateMs(
	internalDate: string | null | undefined,
	headerDate: string | null | undefined,
): number | null {
	if (internalDate) {
		const ts = Number(internalDate);
		if (Number.isFinite(ts) && ts > 0) return ts;
	}
	if (headerDate) {
		const parsed = Date.parse(headerDate);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

export function formatIsoDate(ms: number | null, fallbackHeader?: string | null): string | null {
	if (ms !== null && Number.isFinite(ms)) {
		return new Date(ms).toISOString();
	}
	return fallbackHeader?.trim() || null;
}

export function formatAuditSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	return `${(bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export interface RawDraftAuditInput {
	draft_id: string;
	message_id: string | null;
	thread_id: string | null;
	date: string | null;
	internal_date_ms: number | null;
	to: Mailbox[];
	cc: Mailbox[];
	subject: string | null;
	normalized_subject: string;
	attachments: DraftAuditAttachment[];
	sent_candidates: SentDuplicateCandidate[];
}

function isStrongSentMatch(candidate: SentDuplicateCandidate): boolean {
	return candidate.match_kind === "same_thread_sent" || candidate.match_kind === "subject_and_recipient";
}

function areDraftsInSameGroup(a: RawDraftAuditInput, b: RawDraftAuditInput): boolean {
	if (a.thread_id && b.thread_id && a.thread_id === b.thread_id) {
		return true;
	}
	if (
		a.normalized_subject &&
		b.normalized_subject &&
		a.normalized_subject === b.normalized_subject &&
		hasOverlappingRecipients([...a.to, ...a.cc], [...b.to, ...b.cc])
	) {
		return true;
	}
	return false;
}

function compareDraftRecencyDesc(a: RawDraftAuditInput, b: RawDraftAuditInput): number {
	const timeA = a.internal_date_ms ?? -1;
	const timeB = b.internal_date_ms ?? -1;
	if (timeA !== timeB) return timeB - timeA;
	return b.draft_id.localeCompare(a.draft_id);
}

export function classifyDraftAuditItems(inputs: RawDraftAuditInput[], checkSent: boolean): DraftAuditItem[] {
	// Build connected components of conflicting drafts (same threadId or same normalized subject + overlapping recipient).
	const visited = new Set<number>();
	const groupByIndex = new Map<number, number[]>();

	for (let i = 0; i < inputs.length; i++) {
		if (visited.has(i)) continue;
		const queue = [i];
		const component: number[] = [];
		visited.add(i);
		while (queue.length > 0) {
			const current = queue.shift()!;
			component.push(current);
			for (let j = 0; j < inputs.length; j++) {
				if (!visited.has(j) && areDraftsInSameGroup(inputs[current], inputs[j])) {
					visited.add(j);
					queue.push(j);
				}
			}
		}
		for (const idx of component) {
			groupByIndex.set(idx, component);
		}
	}

	return inputs.map((item, idx) => {
		const groupIndices = groupByIndex.get(idx) || [idx];
		const conflictDraftIds = groupIndices.filter((i) => i !== idx).map((i) => inputs[i].draft_id);
		const sortedGroup = [...groupIndices].sort((a, b) => compareDraftRecencyDesc(inputs[a], inputs[b]));
		const isNewestInGroup = sortedGroup[0] === idx;
		const hasMultipleDrafts = groupIndices.length > 1;

		const strongSent = item.sent_candidates.filter(isStrongSentMatch);
		const ambiguousSent = item.sent_candidates.filter((c) => !isStrongSentMatch(c));
		const allRecipients = [...item.to, ...item.cc];
		const hasRecipients = extractEmailAddresses(allRecipients).length > 0;
		const hasSubject = Boolean(item.normalized_subject);

		let disposition: DraftAuditDisposition;
		let reason: string;

		if (hasMultipleDrafts && !isNewestInGroup) {
			disposition = "conflicting_obsolete_candidate";
			const newestId = inputs[sortedGroup[0]].draft_id;
			reason =
				strongSent.length > 0
					? `Older of ${groupIndices.length} drafts for same thread/subject+recipient (newer draft ${newestId}; also matches sent ${strongSent[0].message_id})`
					: `Older of ${groupIndices.length} drafts for same thread/subject+recipient (superseded by newer draft ${newestId})`;
		} else if (!checkSent) {
			disposition = "needs_human_decision";
			reason = "Sent mail not checked (re-run with --check-sent)";
		} else if (strongSent.length > 0) {
			disposition = "likely_duplicate_sent";
			const first = strongSent[0];
			const basis =
				first.match_kind === "same_thread_sent"
					? "same-thread sent message"
					: "matching sent subject and recipient";
			reason = `Matches ${basis} (${first.message_id}${first.date ? ` on ${first.date.slice(0, 10)}` : ""})`;
		} else if (!hasSubject || !hasRecipients) {
			disposition = "needs_human_decision";
			reason =
				!hasSubject && !hasRecipients
					? "Missing subject and recipients; cannot reliably verify sent duplicates"
					: !hasRecipients
						? "Missing recipients; cannot reliably verify sent duplicates"
						: "Missing subject; cannot reliably verify sent duplicates";
		} else if (ambiguousSent.length > 0) {
			disposition = "needs_human_decision";
			const first = ambiguousSent[0];
			reason =
				first.match_kind === "same_thread_earlier_sent"
					? `Earlier sent message (${first.message_id}) exists in thread before a newer reply; verify manually`
					: `Ambiguous sent match (${first.message_id}) on subject with different recipients; verify manually`;
		} else {
			disposition = "not_proven_duplicate";
			reason = "Checked sent mail; no matching sent duplicate found";
		}

		return {
			draft_id: item.draft_id,
			message_id: item.message_id,
			thread_id: item.thread_id,
			date: item.date,
			internal_date_ms: item.internal_date_ms,
			to: item.to,
			cc: item.cc,
			subject: item.subject,
			attachments: item.attachments,
			disposition,
			reason,
			sent_candidates: item.sent_candidates,
			conflict_draft_ids: conflictDraftIds,
		};
	});
}

export function summarizeDraftAudit(drafts: DraftAuditItem[]): DraftAuditSummary {
	const summary: DraftAuditSummary = {
		total: drafts.length,
		likely_duplicate_sent: 0,
		conflicting_obsolete_candidate: 0,
		not_proven_duplicate: 0,
		needs_human_decision: 0,
	};
	for (const draft of drafts) {
		summary[draft.disposition]++;
	}
	return summary;
}

function escapeMdCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function formatRecipientsCell(to: Mailbox[], cc: Mailbox[]): string {
	const toStr = to.map((m) => m.email || m.name || "").filter(Boolean);
	const ccStr = cc.map((m) => m.email || m.name || "").filter(Boolean);
	const parts: string[] = [];
	if (toStr.length > 0) parts.push(toStr.join(", "));
	if (ccStr.length > 0) parts.push(`cc: ${ccStr.join(", ")}`);
	return parts.join("; ") || "(none)";
}

function formatAttachmentsCell(attachments: DraftAuditAttachment[]): string {
	if (attachments.length === 0) return "-";
	return attachments.map((a) => `${a.filename} (${formatAuditSize(a.size)})`).join(", ");
}

function formatSentCandidatesCell(candidates: SentDuplicateCandidate[]): string {
	if (candidates.length === 0) return "-";
	return candidates
		.map((c) => {
			const datePart = c.date ? ` ${c.date.slice(0, 16).replace("T", " ")}` : "";
			return `\`${c.message_id}\`${datePart} (${c.match_kind})`;
		})
		.join("; ");
}

function formatShortDate(date: string | null): string {
	if (!date) return "-";
	const parsed = Date.parse(date);
	if (Number.isFinite(parsed)) {
		return new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
	}
	return date;
}

export function formatDraftAuditMarkdown(result: DraftAuditResult): string {
	const lines: string[] = [];
	lines.push(`### Stale Draft Audit (${result.account})`);
	lines.push("");
	lines.push(
		`- Filter: \`older_than:${result.older_than}\` | Sent check: \`${result.check_sent ? "enabled" : "disabled"}\` | Mode: read-only (no drafts sent or deleted)`,
	);
	lines.push(
		`- Summary: **${result.summary.total}** stale draft(s) — ` +
			`\`likely_duplicate_sent\`: ${result.summary.likely_duplicate_sent}, ` +
			`\`conflicting_obsolete_candidate\`: ${result.summary.conflicting_obsolete_candidate}, ` +
			`\`not_proven_duplicate\`: ${result.summary.not_proven_duplicate}, ` +
			`\`needs_human_decision\`: ${result.summary.needs_human_decision}`,
	);
	lines.push(`- ${result.verification_note}`);
	lines.push("");

	if (result.drafts.length === 0) {
		lines.push("No stale drafts found.");
		return lines.join("\n");
	}

	lines.push(
		"| Disposition | Draft ID | Message ID | Thread ID | Date | Recipients | Subject | Attachments | Sent Evidence | Notes |",
	);
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

	for (const d of result.drafts) {
		const row = [
			`\`${d.disposition}\``,
			`\`${d.draft_id}\``,
			d.message_id ? `\`${d.message_id}\`` : "-",
			d.thread_id ? `\`${d.thread_id}\`` : "-",
			formatShortDate(d.date),
			formatRecipientsCell(d.to, d.cc),
			d.subject || "(no subject)",
			formatAttachmentsCell(d.attachments),
			formatSentCandidatesCell(d.sent_candidates),
			d.reason,
		].map(escapeMdCell);
		lines.push(`| ${row.join(" | ")} |`);
	}

	return lines.join("\n");
}

export function formatDraftAuditTable(result: DraftAuditResult): string {
	if (result.drafts.length === 0) {
		return "No stale drafts";
	}
	const sanitize = (v: string) => v.replace(/[\t\r\n]+/g, " ").trim();
	const lines = [
		"DISPOSITION\tDRAFT_ID\tMESSAGE_ID\tTHREAD_ID\tDATE\tRECIPIENTS\tSUBJECT\tATTACHMENTS\tSENT_EVIDENCE\tNOTES",
	];
	for (const d of result.drafts) {
		const sentStr =
			d.sent_candidates.length === 0
				? "-"
				: d.sent_candidates
						.map((c) => `${c.message_id}${c.date ? `@${c.date.slice(0, 16)}` : ""}(${c.match_kind})`)
						.join(",");
		lines.push(
			[
				d.disposition,
				d.draft_id,
				d.message_id || "",
				d.thread_id || "",
				formatShortDate(d.date),
				formatRecipientsCell(d.to, d.cc),
				d.subject || "(no subject)",
				formatAttachmentsCell(d.attachments),
				sentStr,
				d.reason,
			]
				.map(sanitize)
				.join("\t"),
		);
	}
	return lines.join("\n");
}

export function parseRecipientsHeaders(
	toHeader: string | undefined,
	ccHeader: string | undefined,
): { to: Mailbox[]; cc: Mailbox[] } {
	return {
		to: parseMailboxList(toHeader),
		cc: parseMailboxList(ccHeader),
	};
}
