import { spawn } from "child_process";
import * as crypto from "crypto";
import * as http from "http";
import type { AddressInfo } from "net";
import * as readline from "readline";
import { OAuth2Client } from "google-auth-library";

const SCOPES = ["https://mail.google.com/"];
const TIMEOUT_MS = 2 * 60 * 1000;

interface AuthResult {
	success: boolean;
	refreshToken?: string;
	error?: string;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function verifyOAuthState(expectedState: string, receivedState: string | null | undefined): boolean {
	if (!expectedState || !receivedState) return false;
	const expectedBuf = Buffer.from(expectedState, "utf8");
	const receivedBuf = Buffer.from(receivedState, "utf8");
	if (expectedBuf.length !== receivedBuf.length) return false;
	return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

export class GmailOAuthFlow {
	private readonly clientId: string;
	private readonly clientSecret: string;
	private oauth2Client: OAuth2Client;
	private server: http.Server | null = null;
	private timeoutId: NodeJS.Timeout | null = null;

	constructor(clientId: string, clientSecret: string) {
		this.clientId = clientId;
		this.clientSecret = clientSecret;
		this.oauth2Client = new OAuth2Client(clientId, clientSecret);
	}

	protected createOAuth2Client(redirectUri: string): OAuth2Client {
		return new OAuth2Client(this.clientId, this.clientSecret, redirectUri);
	}

	async authorize(manual = false): Promise<string> {
		const result = manual ? await this.startManualFlow() : await this.startAuthFlow();
		if (!result.success) {
			throw new Error(result.error || "Authorization failed");
		}
		if (!result.refreshToken) {
			throw new Error("No refresh token received");
		}
		return result.refreshToken;
	}

	private async startManualFlow(): Promise<AuthResult> {
		const redirectUri = "http://localhost:1";
		const expectedState = crypto.randomBytes(24).toString("hex");
		this.oauth2Client = this.createOAuth2Client(redirectUri);

		const authUrl = this.oauth2Client.generateAuthUrl({
			access_type: "offline",
			prompt: "consent",
			scope: SCOPES,
			state: expectedState,
		});

		console.log("Visit this URL to authorize:");
		console.log(authUrl);
		console.log("");
		console.log("After authorizing, you'll be redirected to a page that won't load.");
		console.log("Copy the URL from your browser's address bar and paste it here.");
		console.log("");

		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

		return new Promise((resolve) => {
			rl.question("Paste redirect URL: ", async (input) => {
				rl.close();
				try {
					const parsed = new URL(input.trim());
					if (!verifyOAuthState(expectedState, parsed.searchParams.get("state"))) {
						resolve({ success: false, error: "OAuth state mismatch" });
						return;
					}
					const error = parsed.searchParams.get("error");
					if (error) {
						resolve({ success: false, error });
						return;
					}
					const code = parsed.searchParams.get("code");
					if (!code) {
						resolve({ success: false, error: "No authorization code found in URL" });
						return;
					}
					const { tokens } = await this.oauth2Client.getToken(code);
					resolve({ success: true, refreshToken: tokens.refresh_token || undefined });
				} catch (e) {
					resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
				}
			});
		});
	}

	private startAuthFlow(): Promise<AuthResult> {
		const expectedState = crypto.randomBytes(24).toString("hex");

		return new Promise((resolve) => {
			this.server = http.createServer((req, res) => {
				const parsed = new URL(req.url || "/", "http://localhost");
				if (parsed.pathname === "/") {
					void this.handleCallback(parsed.searchParams, expectedState, res, resolve);
				} else {
					res.writeHead(404);
					res.end();
				}
			});

			this.server.listen(0, "localhost", () => {
				const port = (this.server!.address() as AddressInfo).port;
				const redirectUri = `http://localhost:${port}`;

				this.oauth2Client = this.createOAuth2Client(redirectUri);

				const authUrl = this.oauth2Client.generateAuthUrl({
					access_type: "offline",
					prompt: "consent",
					scope: SCOPES,
					state: expectedState,
				});

				console.log("Opening browser for Gmail authorization...");
				console.log("If browser doesn't open, visit this URL:");
				console.log(authUrl);
				this.openBrowser(authUrl);

				this.timeoutId = setTimeout(() => {
					console.log("Authorization timed out after 2 minutes");
					this.cleanup();
					resolve({ success: false, error: "Authorization timed out" });
				}, TIMEOUT_MS);
			});

			this.server.on("error", (err) => {
				this.cleanup();
				resolve({ success: false, error: err.message });
			});
		});
	}

	private async handleCallback(
		searchParams: URLSearchParams,
		expectedState: string,
		res: http.ServerResponse,
		resolve: (result: AuthResult) => void,
	): Promise<void> {
		const receivedState = searchParams.get("state");
		if (!verifyOAuthState(expectedState, receivedState)) {
			res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				"<html><body><h1>Invalid OAuth state</h1><p>State verification failed. Please retry authorization.</p></body></html>",
			);
			this.cleanup();
			resolve({ success: false, error: "OAuth state mismatch" });
			return;
		}

		const error = searchParams.get("error");
		if (error) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<html><body><h1>Authorization cancelled</h1><p>${escapeHtml(error)}</p></body></html>`);
			this.cleanup();
			resolve({ success: false, error });
			return;
		}

		const code = searchParams.get("code");
		if (!code) {
			res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<html><body><h1>No authorization code</h1></body></html>");
			this.cleanup();
			resolve({ success: false, error: "No authorization code" });
			return;
		}

		try {
			const { tokens } = await this.oauth2Client.getToken(code);
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<html><body><h1>Success!</h1><p>You can close this window.</p></body></html>");
			this.cleanup();
			resolve({ success: true, refreshToken: tokens.refresh_token || undefined });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<html><body><h1>Error</h1><p>${escapeHtml(message)}</p></body></html>`);
			this.cleanup();
			resolve({ success: false, error: message });
		}
	}

	private cleanup(): void {
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = null;
		}
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}

	private openBrowser(targetUrl: string): void {
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		spawn(cmd, [targetUrl], { detached: true, stdio: "ignore" });
	}
}
