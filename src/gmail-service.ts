import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OAuth2Client } from "google-auth-library";
import { type gmail_v1, google } from "googleapis";
import { AccountStorage } from "./account-storage.js";
import {
	type DraftAuditResult,
	type RawDraftAuditInput,
	type SentDuplicateCandidate,
	type SentMatchKind,
	THREAD_VERIFICATION_NOTE,
	buildSentSearchQuery,
	classifyDraftAuditItems,
	formatIsoDate,
	hasOverlappingRecipients,
	isSentMessage,
	parseMessageDateMs,
	parseOlderThan,
	parseRecipientsHeaders,
	summarizeDraftAudit,
} from "./drafts-audit.js";
import { GmailOAuthFlow } from "./gmail-oauth-flow.js";
import type { EmailAccount } from "./types.js";

type GmailMessage = gmail_v1.Schema$Message;
type GmailThread = gmail_v1.Schema$Thread;
type GmailDraft = gmail_v1.Schema$Draft;

export interface ThreadSearchResult {
	threads: Array<{
		id: string;
		historyId: string;
		messages: Array<{
			id: string;
			threadId: string;
			labelIds: string[];
			snippet: string;
			historyId: string;
			internalDate: string;
			from: string | undefined;
			to: string | undefined;
			subject: string | undefined;
			date: string | undefined;
			hasAttachments: boolean;
		}>;
	}>;
	nextPageToken?: string;
}

export interface AttachmentDownloadResult {
	success: boolean;
	filename: string;
	path?: string;
	error?: string;
	cached?: boolean;
}

export interface DownloadedAttachment {
	messageId: string;
	filename: string;
	path: string;
	size: number;
	mimeType: string;
	cached: boolean;
}

export interface AttachmentPartInfo {
	filename: string;
	size: number;
	mimeType: string;
	attachmentId?: string;
	inlineData?: string;
	partPath: string;
}

interface AttachmentDownloadTarget extends AttachmentPartInfo {
	messageId: string;
}

export function collectAttachmentParts(payload: gmail_v1.Schema$MessagePart | null | undefined): AttachmentPartInfo[] {
	const attachments: AttachmentPartInfo[] = [];

	const walk = (part: gmail_v1.Schema$MessagePart | null | undefined, partPath: string) => {
		if (!part) return;

		const filename = part.filename?.trim();
		if (filename) {
			attachments.push({
				filename,
				size: part.body?.size || 0,
				mimeType: part.mimeType || "application/octet-stream",
				attachmentId: part.body?.attachmentId || undefined,
				inlineData: part.body?.data || undefined,
				partPath,
			});
		}

		for (let i = 0; i < (part.parts || []).length; i++) {
			walk(part.parts?.[i], `${partPath}.${i}`);
		}
	};

	walk(payload, "0");
	return attachments;
}

export function hasAttachmentParts(payload: gmail_v1.Schema$MessagePart | null | undefined): boolean {
	return collectAttachmentParts(payload).length > 0;
}

export function isDraftMessage(message: Pick<GmailMessage, "labelIds"> | null | undefined): boolean {
	return message?.labelIds?.includes("DRAFT") || false;
}

export function selectLatestReplyMessage(messages: GmailMessage[] | null | undefined): GmailMessage | undefined {
	if (!messages || messages.length === 0) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate?.id && !isDraftMessage(candidate)) {
			return candidate;
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate?.id) {
			return candidate;
		}
	}
	return undefined;
}

export function normalizeSubjectForThreadComparison(subject: string | undefined): string {
	return (subject || "")
		.trim()
		.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, "")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

export function canonicalReplySubject(requestedSubject: string, sourceSubject: string | undefined): string {
	if (!sourceSubject) return requestedSubject;
	if (!requestedSubject.trim()) return sourceSubject;

	return normalizeSubjectForThreadComparison(requestedSubject) === normalizeSubjectForThreadComparison(sourceSubject)
		? sourceSubject
		: requestedSubject;
}

export function encodeMimeHeader(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export interface LabelOperationResult {
	threadId: string;
	success: boolean;
	error?: string;
}

export class GmailService {
	private accountStorage = new AccountStorage();
	private gmailClients: Map<string, any> = new Map();

	async addGmailAccount(email: string, clientId: string, clientSecret: string, manual = false): Promise<void> {
		if (this.accountStorage.hasAccount(email)) {
			throw new Error(`Account '${email}' already exists`);
		}

		const oauthFlow = new GmailOAuthFlow(clientId, clientSecret);
		const refreshToken = await oauthFlow.authorize(manual);

		const account: EmailAccount = {
			email,
			oauth2: { clientId, clientSecret, refreshToken },
		};

		this.accountStorage.addAccount(account);
	}

	deleteAccount(email: string): boolean {
		this.gmailClients.delete(email);
		return this.accountStorage.deleteAccount(email);
	}

	listAccounts(): EmailAccount[] {
		return this.accountStorage.getAllAccounts();
	}

	setCredentials(clientId: string, clientSecret: string): void {
		this.accountStorage.setCredentials(clientId, clientSecret);
	}

	getCredentials(): { clientId: string; clientSecret: string } | null {
		return this.accountStorage.getCredentials();
	}

	private getGmailClient(email: string): any {
		if (!this.gmailClients.has(email)) {
			const account = this.accountStorage.getAccount(email);
			if (!account) {
				throw new Error(`Account '${email}' not found`);
			}

			// Prefer Doppler-injected env credentials. Fall back to per-account
			// stored credentials only for backward compatibility with older
			// accounts.json records that pre-date the env-first migration.
			const sharedCreds = this.accountStorage.getCredentials();
			const clientId = sharedCreds?.clientId || account.oauth2.clientId;
			const clientSecret = sharedCreds?.clientSecret || account.oauth2.clientSecret;

			if (!clientId || !clientSecret) {
				throw new Error(
					"OAuth client credentials not found. Set GMCLI_CLIENT_ID and GMCLI_CLIENT_SECRET " +
						"(typically via `doppler run -- gmcli ...`), or run `gmcli accounts credentials <file.json>`.",
				);
			}

			const oauth2Client = new OAuth2Client(clientId, clientSecret, "http://localhost");

			oauth2Client.setCredentials({
				refresh_token: account.oauth2.refreshToken,
				access_token: account.oauth2.accessToken,
			});

			const gmail = google.gmail({ version: "v1", auth: oauth2Client });
			this.gmailClients.set(email, gmail);
		}

		return this.gmailClients.get(email)!;
	}

	async searchThreads(email: string, query: string, maxResults = 10, pageToken?: string): Promise<ThreadSearchResult> {
		const gmail = this.getGmailClient(email);
		const response = await gmail.users.threads.list({
			userId: "me",
			q: query,
			maxResults,
			pageToken,
		});

		const threads = response.data.threads || [];
		const detailedThreads: GmailThread[] = [];

		for (const thread of threads) {
			const detail = (await this.getThread(email, thread.id, false)) as GmailThread;
			detailedThreads.push(detail);
		}

		return {
			threads: detailedThreads.map((thread) => ({
				id: thread.id || "",
				historyId: thread.historyId || "",
				messages: (thread.messages || []).map((msg) => ({
					id: msg.id || "",
					threadId: msg.threadId || "",
					labelIds: msg.labelIds || [],
					snippet: msg.snippet || "",
					historyId: msg.historyId || "",
					internalDate: msg.internalDate || "",
					from: this.getHeaderValue(msg, "from"),
					to: this.getHeaderValue(msg, "to"),
					subject: this.getHeaderValue(msg, "subject"),
					date: this.getHeaderValue(msg, "date"),
					hasAttachments: hasAttachmentParts(msg.payload),
				})),
			})),
			nextPageToken: response.data.nextPageToken,
		};
	}

	async getThread(
		email: string,
		threadId: string,
		downloadAttachments = false,
	): Promise<GmailThread | DownloadedAttachment[]> {
		const gmail = this.getGmailClient(email);
		const response = await gmail.users.threads.get({
			userId: "me",
			id: threadId,
		});

		const thread = response.data;

		if (!downloadAttachments) {
			return thread;
		}

		const attachmentMetadata: AttachmentDownloadTarget[] = (thread.messages || []).flatMap((message: GmailMessage) =>
			collectAttachmentParts(message.payload).map((part: AttachmentPartInfo) => ({
				messageId: message.id!,
				filename: part.filename,
				size: part.size,
				mimeType: part.mimeType,
				attachmentId: part.attachmentId,
				inlineData: part.inlineData,
				partPath: part.partPath,
			})),
		);

		const attachmentsToDownload = attachmentMetadata.filter(
			(part: AttachmentDownloadTarget) => part.attachmentId || part.inlineData,
		);

		const downloadResults = await this.downloadAttachments(
			email,
			attachmentsToDownload.map((att: AttachmentDownloadTarget) => ({
				messageId: att.messageId,
				attachmentId: att.attachmentId,
				inlineData: att.inlineData,
				filename: att.filename,
				partPath: att.partPath,
			})),
		);

		const downloadedAttachments: DownloadedAttachment[] = [];

		for (let i = 0; i < attachmentsToDownload.length; i++) {
			const attachment = attachmentsToDownload[i];
			const result = downloadResults[i];

			if (result.success && result.path) {
				downloadedAttachments.push({
					messageId: attachment.messageId,
					filename: attachment.filename,
					path: result.path,
					size: attachment.size,
					mimeType: attachment.mimeType,
					cached: result.cached || false,
				});
			}
		}

		if (attachmentMetadata.length > 0 && downloadedAttachments.length === 0) {
			console.error(
				`[gmcli] Warning: attachment metadata listed ${attachmentMetadata.length} attachment(s), but none were downloaded for thread ${threadId}.`,
			);
		}

		return downloadedAttachments;
	}

	async downloadAttachments(
		email: string,
		attachments: Array<{
			messageId: string;
			attachmentId?: string;
			inlineData?: string;
			filename: string;
			partPath: string;
		}>,
	): Promise<AttachmentDownloadResult[]> {
		const gmail = this.getGmailClient(email);
		const results: AttachmentDownloadResult[] = [];

		const attachmentDir = path.join(os.homedir(), ".gmcli", "attachments");
		if (!fs.existsSync(attachmentDir)) {
			fs.mkdirSync(attachmentDir, { recursive: true });
		}

		for (const attachment of attachments) {
			try {
				const sourceKey =
					attachment.attachmentId?.substring(0, 8) || `part-${attachment.partPath.replace(/\./g, "-")}`;
				const filename = `${attachment.messageId}_${sourceKey}_${attachment.filename}`;
				const filePath = path.join(attachmentDir, filename);

				if (attachment.inlineData) {
					const data = Buffer.from(attachment.inlineData, "base64url");
					if (fs.existsSync(filePath) && fs.statSync(filePath).size === data.length) {
						results.push({ success: true, filename: attachment.filename, path: filePath, cached: true });
						continue;
					}

					fs.writeFileSync(filePath, data);
					results.push({ success: true, filename: attachment.filename, path: filePath, cached: false });
					continue;
				}

				if (!attachment.attachmentId) {
					throw new Error("Attachment has no attachmentId or inline data");
				}

				if (fs.existsSync(filePath)) {
					const existingSize = fs.statSync(filePath).size;
					const attachmentInfo = await gmail.users.messages.attachments.get({
						userId: "me",
						messageId: attachment.messageId,
						id: attachment.attachmentId,
					});

					if (existingSize === attachmentInfo.data.size) {
						results.push({ success: true, filename: attachment.filename, path: filePath, cached: true });
						continue;
					}
				}

				const response = await gmail.users.messages.attachments.get({
					userId: "me",
					messageId: attachment.messageId,
					id: attachment.attachmentId,
				});

				const data = Buffer.from(response.data.data, "base64url");
				fs.writeFileSync(filePath, data);

				results.push({ success: true, filename: attachment.filename, path: filePath, cached: false });
			} catch (e) {
				results.push({
					success: false,
					filename: attachment.filename,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		return results;
	}

	async modifyLabels(
		email: string,
		threadIds: string[],
		addLabels: string[] = [],
		removeLabels: string[] = [],
	): Promise<LabelOperationResult[]> {
		const gmail = this.getGmailClient(email);
		const results: LabelOperationResult[] = [];

		for (const threadId of threadIds) {
			try {
				if (addLabels.length > 0) {
					await gmail.users.threads.modify({
						userId: "me",
						id: threadId,
						requestBody: { addLabelIds: addLabels },
					});
				}
				if (removeLabels.length > 0) {
					await gmail.users.threads.modify({
						userId: "me",
						id: threadId,
						requestBody: { removeLabelIds: removeLabels },
					});
				}
				results.push({ threadId, success: true });
			} catch (e) {
				results.push({ threadId, success: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		return results;
	}

	async listDrafts(email: string): Promise<GmailDraft[]> {
		const gmail = this.getGmailClient(email);
		const response = await gmail.users.drafts.list({ userId: "me" });
		return response.data.drafts || [];
	}

	async auditDrafts(
		email: string,
		options: {
			olderThan?: string;
			checkSent?: boolean;
			maxResults?: number;
			nowMs?: number;
		} = {},
	): Promise<DraftAuditResult> {
		const gmail = this.getGmailClient(email);
		const parsedOlderThan = parseOlderThan(options.olderThan ?? "1d", options.nowMs);
		const checkSent = Boolean(options.checkSent);
		const maxResults = options.maxResults ?? 50;

		const rawItems: RawDraftAuditInput[] = [];
		let pageToken: string | undefined;

		while (rawItems.length < maxResults) {
			const listParams: { userId: string; q?: string; maxResults: number; pageToken?: string } = {
				userId: "me",
				maxResults: Math.min(100, Math.max(maxResults - rawItems.length, 10)),
			};
			if (parsedOlderThan.gmailQueryToken) {
				listParams.q = parsedOlderThan.gmailQueryToken;
			}
			if (pageToken) {
				listParams.pageToken = pageToken;
			}

			const listResp = await gmail.users.drafts.list(listParams);
			const draftStubs: GmailDraft[] = listResp.data.drafts || [];
			if (draftStubs.length === 0) break;

			for (const stub of draftStubs) {
				if (!stub.id) continue;
				const draftResp = await gmail.users.drafts.get({
					userId: "me",
					id: stub.id,
					format: "full",
				});
				const draft: GmailDraft = draftResp.data;
				const msg = draft.message;
				const headerDate = msg ? this.getHeaderValue(msg, "date") : undefined;
				const internalDateMs = parseMessageDateMs(msg?.internalDate, headerDate);

				if (
					parsedOlderThan.cutoffMs !== null &&
					internalDateMs !== null &&
					internalDateMs > parsedOlderThan.cutoffMs
				) {
					continue;
				}

				const { to, cc } = parseRecipientsHeaders(
					msg ? this.getHeaderValue(msg, "to") : undefined,
					msg ? this.getHeaderValue(msg, "cc") : undefined,
				);
				const subject = (msg ? this.getHeaderValue(msg, "subject") : undefined) || null;
				const attachments = collectAttachmentParts(msg?.payload).map((att) => ({
					filename: att.filename,
					size: att.size,
					mime_type: att.mimeType,
				}));

				rawItems.push({
					draft_id: draft.id || stub.id,
					message_id: msg?.id || null,
					thread_id: msg?.threadId || null,
					date: formatIsoDate(internalDateMs, headerDate),
					internal_date_ms: internalDateMs,
					to,
					cc,
					subject,
					normalized_subject: normalizeSubjectForThreadComparison(subject || undefined),
					attachments,
					sent_candidates: [],
				});

				if (rawItems.length >= maxResults) break;
			}

			pageToken = listResp.data.nextPageToken || undefined;
			if (!pageToken) break;
		}

		if (checkSent && rawItems.length > 0) {
			const threadCache = new Map<string, GmailThread | null>();
			const sentQueryCache = new Map<string, GmailMessage[]>();
			const messageCache = new Map<string, GmailMessage | null>();

			const fetchThread = async (threadId: string): Promise<GmailThread | null> => {
				if (threadCache.has(threadId)) return threadCache.get(threadId) ?? null;
				try {
					const resp = await gmail.users.threads.get({
						userId: "me",
						id: threadId,
						format: "metadata",
						metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
					});
					const thread: GmailThread = resp.data;
					threadCache.set(threadId, thread);
					return thread;
				} catch {
					threadCache.set(threadId, null);
					return null;
				}
			};

			const fetchMessageMetadata = async (messageId: string): Promise<GmailMessage | null> => {
				if (messageCache.has(messageId)) return messageCache.get(messageId) ?? null;
				try {
					const resp = await gmail.users.messages.get({
						userId: "me",
						id: messageId,
						format: "metadata",
						metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
					});
					const message: GmailMessage = resp.data;
					messageCache.set(messageId, message);
					return message;
				} catch {
					messageCache.set(messageId, null);
					return null;
				}
			};

			const searchSentMessages = async (query: string): Promise<GmailMessage[]> => {
				if (sentQueryCache.has(query)) return sentQueryCache.get(query) || [];
				const resp = await gmail.users.messages.list({
					userId: "me",
					q: query,
					maxResults: 10,
				});
				const stubs: GmailMessage[] = resp.data.messages || [];
				const messages: GmailMessage[] = [];
				for (const stub of stubs) {
					if (!stub.id) continue;
					const msg = await fetchMessageMetadata(stub.id);
					if (msg && isSentMessage(msg)) {
						messages.push(msg);
					}
				}
				sentQueryCache.set(query, messages);
				return messages;
			};

			for (const item of rawItems) {
				const candidatesById = new Map<string, SentDuplicateCandidate>();

				if (item.thread_id) {
					const thread = await fetchThread(item.thread_id);
					const threadMessages = thread?.messages || [];

					let latestInboundMs: number | null = null;
					for (const msg of threadMessages) {
						if (!msg.id || isDraftMessage(msg) || isSentMessage(msg)) continue;
						const ms = parseMessageDateMs(msg.internalDate, this.getHeaderValue(msg, "date"));
						if (ms !== null && (latestInboundMs === null || ms > latestInboundMs)) {
							latestInboundMs = ms;
						}
					}

					for (const msg of threadMessages) {
						if (!msg.id || !isSentMessage(msg)) continue;
						const headerDate = this.getHeaderValue(msg, "date");
						const sentMs = parseMessageDateMs(msg.internalDate, headerDate);
						const { to, cc } = parseRecipientsHeaders(
							this.getHeaderValue(msg, "to"),
							this.getHeaderValue(msg, "cc"),
						);
						const isEarlierBeforeInbound =
							latestInboundMs !== null &&
							sentMs !== null &&
							latestInboundMs > sentMs &&
							(item.internal_date_ms === null || item.internal_date_ms > sentMs);
						const matchKind: SentMatchKind = isEarlierBeforeInbound
							? "same_thread_earlier_sent"
							: "same_thread_sent";

						candidatesById.set(msg.id, {
							message_id: msg.id,
							thread_id: msg.threadId || item.thread_id,
							date: formatIsoDate(sentMs, headerDate),
							internal_date_ms: sentMs,
							to,
							cc,
							subject: this.getHeaderValue(msg, "subject") || null,
							match_kind: matchKind,
						});
					}
				}

				const query = buildSentSearchQuery(item.normalized_subject, [...item.to, ...item.cc]);
				if (query) {
					const sentMessages = await searchSentMessages(query);
					for (const msg of sentMessages) {
						if (!msg.id || candidatesById.has(msg.id)) continue;
						const headerDate = this.getHeaderValue(msg, "date");
						const sentMs = parseMessageDateMs(msg.internalDate, headerDate);
						const sentSubject = this.getHeaderValue(msg, "subject") || null;
						const sentNormalizedSubject = normalizeSubjectForThreadComparison(sentSubject || undefined);
						const { to, cc } = parseRecipientsHeaders(
							this.getHeaderValue(msg, "to"),
							this.getHeaderValue(msg, "cc"),
						);

						const subjectMatches =
							Boolean(item.normalized_subject) &&
							Boolean(sentNormalizedSubject) &&
							item.normalized_subject === sentNormalizedSubject;
						const recipientOverlaps = hasOverlappingRecipients([...item.to, ...item.cc], [...to, ...cc]);

						if (subjectMatches && recipientOverlaps) {
							candidatesById.set(msg.id, {
								message_id: msg.id,
								thread_id: msg.threadId || null,
								date: formatIsoDate(sentMs, headerDate),
								internal_date_ms: sentMs,
								to,
								cc,
								subject: sentSubject,
								match_kind: "subject_and_recipient",
							});
						} else if (subjectMatches) {
							candidatesById.set(msg.id, {
								message_id: msg.id,
								thread_id: msg.threadId || null,
								date: formatIsoDate(sentMs, headerDate),
								internal_date_ms: sentMs,
								to,
								cc,
								subject: sentSubject,
								match_kind: "subject_only",
							});
						}
					}
				}

				item.sent_candidates = [...candidatesById.values()].sort(
					(a, b) => (b.internal_date_ms ?? -1) - (a.internal_date_ms ?? -1),
				);
			}
		}

		const drafts = classifyDraftAuditItems(rawItems, checkSent);
		return {
			account: email,
			older_than: parsedOlderThan.raw,
			check_sent: checkSent,
			read_only: true,
			verification_note: THREAD_VERIFICATION_NOTE,
			summary: summarizeDraftAudit(drafts),
			drafts,
		};
	}

	async listLabels(email: string): Promise<Array<{ id: string; name: string; type: string }>> {
		const gmail = this.getGmailClient(email);
		const response = await gmail.users.labels.list({ userId: "me" });
		return (response.data.labels || []).map((l: any) => ({
			id: l.id || "",
			name: l.name || "",
			type: l.type || "",
		}));
	}

	async getLabelMap(email: string): Promise<{ idToName: Map<string, string>; nameToId: Map<string, string> }> {
		const labels = await this.listLabels(email);
		const idToName = new Map<string, string>();
		const nameToId = new Map<string, string>();
		for (const l of labels) {
			idToName.set(l.id, l.name);
			nameToId.set(l.name.toLowerCase(), l.id);
		}
		return { idToName, nameToId };
	}

	resolveLabelIds(labels: string[], nameToId: Map<string, string>): string[] {
		return labels.map((l) => nameToId.get(l.toLowerCase()) || l);
	}

	private async resolveReplyTarget(
		gmail: any,
		replyToId: string,
	): Promise<{ message: GmailMessage; threadId?: string }> {
		const fetchMetadata = async (id: string): Promise<GmailMessage> => {
			const response = await gmail.users.messages.get({
				userId: "me",
				id,
				format: "metadata",
				metadataHeaders: ["Message-ID", "References", "Subject"],
			});
			return response.data;
		};

		const resolveFromThread = async (
			threadId: string,
		): Promise<{ message: GmailMessage; threadId: string } | null> => {
			const thread = await gmail.users.threads.get({
				userId: "me",
				id: threadId,
				format: "minimal",
			});
			const latest = selectLatestReplyMessage(thread.data.messages);
			if (!latest?.id) return null;
			const message = await fetchMetadata(latest.id);
			return {
				message,
				threadId: message.threadId || thread.data.id || threadId,
			};
		};

		try {
			const directMessage = await fetchMetadata(replyToId);
			const directThreadId = directMessage.threadId || undefined;

			// In Gmail, a thread's ID equals its root message's ID. When the caller
			// passes a thread ID to --reply-to, messages.get succeeds with the root
			// message. Resolve the thread so we reply to its latest non-draft message.
			if (directThreadId && directThreadId === replyToId && gmail.users.threads?.get) {
				try {
					const thread = await gmail.users.threads.get({
						userId: "me",
						id: replyToId,
						format: "minimal",
					});
					const latest = selectLatestReplyMessage(thread.data.messages);
					if (latest?.id && latest.id !== replyToId) {
						const latestMessage = await fetchMetadata(latest.id);
						return {
							message: latestMessage,
							threadId: latestMessage.threadId || thread.data.id || directThreadId,
						};
					}
					return {
						message: directMessage,
						threadId: directThreadId || thread.data.id || replyToId,
					};
				} catch {
					// Fall back to the directly fetched message if thread lookup fails.
				}
			}

			return {
				message: directMessage,
				threadId: directThreadId,
			};
		} catch {
			const resolved = await resolveFromThread(replyToId);
			if (!resolved) {
				throw new Error(`Thread '${replyToId}' has no messages to reply to`);
			}
			return resolved;
		}
	}

	private async resolveReplyMetadata(
		gmail: any,
		subject: string,
		options: { threadId?: string; replyToMessageId?: string },
	): Promise<{
		inReplyTo?: string;
		references?: string;
		threadId?: string;
		subject: string;
	}> {
		let inReplyTo: string | undefined;
		let references: string | undefined;
		let threadId = options.threadId;
		let messageSubject = subject;

		if (options.replyToMessageId) {
			const replyTarget = await this.resolveReplyTarget(gmail, options.replyToMessageId);
			const messageId = this.getHeaderValue(replyTarget.message, "Message-ID")?.trim();
			const existingRefs = this.getHeaderValue(replyTarget.message, "References")?.trim();
			const sourceSubject = this.getHeaderValue(replyTarget.message, "Subject");
			messageSubject = canonicalReplySubject(messageSubject, sourceSubject);

			if (messageId) {
				inReplyTo = messageId;
				if (!existingRefs) {
					references = messageId;
				} else {
					const refTokens = existingRefs.split(/\s+/);
					references = refTokens.includes(messageId) ? existingRefs : `${existingRefs} ${messageId}`;
				}
			}
			threadId = threadId || replyTarget.threadId;
		}

		return { inReplyTo, references, threadId, subject: messageSubject };
	}

	async createDraft(
		email: string,
		to: string[],
		subject: string,
		body: string,
		options: {
			cc?: string[];
			bcc?: string[];
			threadId?: string;
			replyToMessageId?: string;
			attachments?: string[];
			html?: boolean;
		} = {},
	): Promise<GmailDraft> {
		const gmail = this.getGmailClient(email);

		const {
			inReplyTo,
			references,
			threadId,
			subject: messageSubject,
		} = await this.resolveReplyMetadata(gmail, subject, options);

		const hasAttachments = options.attachments && options.attachments.length > 0;
		const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const contentType = options.html ? "text/html" : "text/plain";

		const headers = [
			`From: ${email}`,
			`To: ${to.join(", ")}`,
			options.cc?.length ? `Cc: ${options.cc.join(", ")}` : "",
			options.bcc?.length ? `Bcc: ${options.bcc.join(", ")}` : "",
			`Subject: ${encodeMimeHeader(messageSubject)}`,
			inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
			references ? `References: ${references}` : "",
			"MIME-Version: 1.0",
			hasAttachments
				? `Content-Type: multipart/mixed; boundary="${boundary}"`
				: `Content-Type: ${contentType}; charset=UTF-8`,
		].filter(Boolean);

		let emailContent: string;

		if (hasAttachments) {
			const parts: string[] = [];

			// Body part
			parts.push(`--${boundary}\r\n` + `Content-Type: ${contentType}; charset=UTF-8\r\n\r\n` + body);

			// Attachment parts
			for (const filePath of options.attachments!) {
				const filename = path.basename(filePath);
				const fileContent = fs.readFileSync(filePath);
				const base64Content = fileContent.toString("base64");
				const mimeType = this.getMimeType(filename);

				parts.push(
					`--${boundary}\r\n` +
						`Content-Type: ${mimeType}\r\n` +
						"Content-Transfer-Encoding: base64\r\n" +
						`Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
						base64Content,
				);
			}

			emailContent = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n") + `\r\n--${boundary}--`;
		} else {
			emailContent = headers.join("\r\n") + "\r\n\r\n" + body;
		}

		const encodedEmail = Buffer.from(emailContent).toString("base64url");

		const response = await gmail.users.drafts.create({
			userId: "me",
			requestBody: {
				message: { raw: encodedEmail, threadId },
			},
		});

		return response.data;
	}

	private getMimeType(filename: string): string {
		const ext = path.extname(filename).toLowerCase();
		const mimeTypes: Record<string, string> = {
			".pdf": "application/pdf",
			".doc": "application/msword",
			".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			".xls": "application/vnd.ms-excel",
			".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".txt": "text/plain",
			".html": "text/html",
			".zip": "application/zip",
			".json": "application/json",
		};
		return mimeTypes[ext] || "application/octet-stream";
	}

	async updateDraft(email: string, draftId: string, body: string): Promise<GmailDraft> {
		const gmail = this.getGmailClient(email);
		const draft = await this.getDraft(email, draftId);
		const message = draft.message;

		if (!message) throw new Error("Draft message not found");

		const existingRaw = message.raw ? Buffer.from(message.raw, "base64url").toString() : "";
		const headerEnd = existingRaw.indexOf("\n\n");
		const headers = headerEnd > 0 ? existingRaw.substring(0, headerEnd) : "";

		const updatedEmail = `${headers}\n\n${body}`;
		const encodedEmail = Buffer.from(updatedEmail).toString("base64url");

		const response = await gmail.users.drafts.update({
			userId: "me",
			id: draftId,
			requestBody: {
				message: { raw: encodedEmail, threadId: message.threadId },
			},
		});

		return response.data;
	}

	async getDraft(email: string, draftId: string): Promise<GmailDraft> {
		const gmail = this.getGmailClient(email);
		const response = await gmail.users.drafts.get({ userId: "me", id: draftId });
		return response.data;
	}

	async deleteDraft(email: string, draftId: string): Promise<void> {
		const gmail = this.getGmailClient(email);
		await gmail.users.drafts.delete({ userId: "me", id: draftId });
	}

	async sendDraft(email: string, draftId: string): Promise<GmailMessage> {
		const gmail = this.getGmailClient(email);
		const response = await gmail.users.drafts.send({
			userId: "me",
			requestBody: { id: draftId },
		});
		// Gmail API returns the sent Message directly in response.data
		return response.data;
	}

	async sendMessage(
		email: string,
		to: string[],
		subject: string,
		body: string,
		options: {
			cc?: string[];
			bcc?: string[];
			threadId?: string;
			replyToMessageId?: string;
			attachments?: string[];
			html?: boolean;
		} = {},
	): Promise<GmailMessage> {
		const gmail = this.getGmailClient(email);

		const {
			inReplyTo,
			references,
			threadId,
			subject: messageSubject,
		} = await this.resolveReplyMetadata(gmail, subject, options);

		const hasAttachments = options.attachments && options.attachments.length > 0;
		const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const contentType = options.html ? "text/html" : "text/plain";

		const headers = [
			`From: ${email}`,
			`To: ${to.join(", ")}`,
			options.cc?.length ? `Cc: ${options.cc.join(", ")}` : "",
			options.bcc?.length ? `Bcc: ${options.bcc.join(", ")}` : "",
			`Subject: ${encodeMimeHeader(messageSubject)}`,
			inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
			references ? `References: ${references}` : "",
			"MIME-Version: 1.0",
			hasAttachments
				? `Content-Type: multipart/mixed; boundary="${boundary}"`
				: `Content-Type: ${contentType}; charset=UTF-8`,
		].filter(Boolean);

		let emailContent: string;

		if (hasAttachments) {
			const parts: string[] = [];

			// Body part
			parts.push(`--${boundary}\r\n` + `Content-Type: ${contentType}; charset=UTF-8\r\n\r\n` + body);

			// Attachment parts
			for (const filePath of options.attachments!) {
				const filename = path.basename(filePath);
				const fileContent = fs.readFileSync(filePath);
				const base64Content = fileContent.toString("base64");
				const mimeType = this.getMimeType(filename);

				parts.push(
					`--${boundary}\r\n` +
						`Content-Type: ${mimeType}\r\n` +
						"Content-Transfer-Encoding: base64\r\n" +
						`Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
						base64Content,
				);
			}

			emailContent = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n") + `\r\n--${boundary}--`;
		} else {
			emailContent = headers.join("\r\n") + "\r\n\r\n" + body;
		}

		const encodedEmail = Buffer.from(emailContent).toString("base64url");

		const response = await gmail.users.messages.send({
			userId: "me",
			requestBody: { raw: encodedEmail, threadId },
		});

		return response.data;
	}

	async downloadMessageAttachments(email: string, messageId: string): Promise<DownloadedAttachment[]> {
		const gmail = this.getGmailClient(email);
		const response = await gmail.users.messages.get({ userId: "me", id: messageId });
		const message = response.data;

		const attachmentMetadata: AttachmentDownloadTarget[] = collectAttachmentParts(message.payload).map(
			(part: AttachmentPartInfo) => ({
				messageId,
				filename: part.filename,
				size: part.size,
				mimeType: part.mimeType,
				attachmentId: part.attachmentId,
				inlineData: part.inlineData,
				partPath: part.partPath,
			}),
		);

		const attachmentsToDownload = attachmentMetadata.filter(
			(part: AttachmentDownloadTarget) => part.attachmentId || part.inlineData,
		);

		const downloadResults = await this.downloadAttachments(
			email,
			attachmentsToDownload.map((att: AttachmentDownloadTarget) => ({
				messageId: att.messageId,
				attachmentId: att.attachmentId,
				inlineData: att.inlineData,
				filename: att.filename,
				partPath: att.partPath,
			})),
		);

		const downloadedAttachments: DownloadedAttachment[] = [];
		for (let i = 0; i < attachmentsToDownload.length; i++) {
			const attachment = attachmentsToDownload[i];
			const result = downloadResults[i];
			if (result.success && result.path) {
				downloadedAttachments.push({
					messageId: attachment.messageId,
					filename: attachment.filename,
					path: result.path,
					size: attachment.size,
					mimeType: attachment.mimeType,
					cached: result.cached || false,
				});
			}
		}

		if (attachmentMetadata.length > 0 && downloadedAttachments.length === 0) {
			console.error(
				`[gmcli] Warning: attachment metadata listed ${attachmentMetadata.length} attachment(s), but none were downloaded for message ${messageId}.`,
			);
		}

		return downloadedAttachments;
	}

	private getHeaderValue(message: GmailMessage, headerName: string): string | undefined {
		const header = message.payload?.headers?.find((h) => h.name?.toLowerCase() === headerName.toLowerCase());
		return header?.value || undefined;
	}
}
