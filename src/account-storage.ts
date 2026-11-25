import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EmailAccount } from "./types.js";

// Strip OAuth-app credentials (clientId/clientSecret) from a stored account.
// Those values must come from env (Doppler) at runtime, not at-rest on disk.
function sanitizeForStorage(account: EmailAccount): EmailAccount {
	const { clientId: _cid, clientSecret: _cs, ...rest } = account.oauth2;
	return { email: account.email, oauth2: { ...rest } };
}

export class AccountStorage {
	private readonly configDir: string;
	private readonly accountsFile: string;
	private readonly credentialsFile: string;
	private accounts: Map<string, EmailAccount> = new Map();

	constructor(configDir?: string) {
		this.configDir = configDir || path.join(os.homedir(), ".gmcli");
		this.accountsFile = path.join(this.configDir, "accounts.json");
		this.credentialsFile = path.join(this.configDir, "credentials.json");
		this.ensureConfigDir();
		this.loadAccounts();
	}

	private ensureConfigDir(): void {
		if (!fs.existsSync(this.configDir)) {
			fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
		}
		fs.chmodSync(this.configDir, 0o700);
	}

	private loadAccounts(): void {
		let raw: string;
		try {
			raw = fs.readFileSync(this.accountsFile, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
				return;
			}
			throw new Error(
				`Failed to read accounts file '${this.accountsFile}': ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			throw new Error(
				`Failed to parse accounts file '${this.accountsFile}' as JSON (${err instanceof Error ? err.message : String(err)}). ` +
					"Fix or back up and remove the corrupted file before modifying accounts.",
			);
		}

		if (!Array.isArray(parsed)) {
			throw new Error(
				`Invalid accounts file '${this.accountsFile}': expected a JSON array of accounts. ` +
					"Fix or back up and remove the corrupted file before modifying accounts.",
			);
		}

		for (const account of parsed) {
			if (!account || typeof account !== "object" || typeof (account as EmailAccount).email !== "string") {
				throw new Error(
					`Invalid account entry in '${this.accountsFile}'. ` +
						"Fix or back up and remove the corrupted file before modifying accounts.",
				);
			}
			this.accounts.set((account as EmailAccount).email, account as EmailAccount);
		}
	}

	private writeJsonFileAtomic(targetFile: string, data: unknown): void {
		this.ensureConfigDir();
		const tmpFile = path.join(
			this.configDir,
			`.${path.basename(targetFile)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
		);
		try {
			fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
			fs.chmodSync(tmpFile, 0o600);
			fs.renameSync(tmpFile, targetFile);
		} catch (err) {
			try {
				if (fs.existsSync(tmpFile)) {
					fs.unlinkSync(tmpFile);
				}
			} catch {
				// Ignore cleanup errors
			}
			throw err;
		}
	}

	private saveAccounts(): void {
		const sanitized = Array.from(this.accounts.values()).map(sanitizeForStorage);
		this.writeJsonFileAtomic(this.accountsFile, sanitized);
	}

	addAccount(account: EmailAccount): void {
		this.accounts.set(account.email, account);
		this.saveAccounts();
	}

	getAccount(email: string): EmailAccount | undefined {
		return this.accounts.get(email);
	}

	getAllAccounts(): EmailAccount[] {
		return Array.from(this.accounts.values());
	}

	deleteAccount(email: string): boolean {
		const deleted = this.accounts.delete(email);
		if (deleted) this.saveAccounts();
		return deleted;
	}

	hasAccount(email: string): boolean {
		return this.accounts.has(email);
	}

	setCredentials(clientId: string, clientSecret: string): void {
		this.writeJsonFileAtomic(this.credentialsFile, { clientId, clientSecret });
	}

	getCredentials(): { clientId: string; clientSecret: string } | null {
		const envId = process.env.GMCLI_CLIENT_ID;
		const envSecret = process.env.GMCLI_CLIENT_SECRET;
		if (envId && envSecret) {
			return { clientId: envId, clientSecret: envSecret };
		}
		if (!fs.existsSync(this.credentialsFile)) return null;
		try {
			return JSON.parse(fs.readFileSync(this.credentialsFile, "utf8"));
		} catch {
			return null;
		}
	}
}
