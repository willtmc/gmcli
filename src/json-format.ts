export type Mailbox = {
	name: string | null;
	email: string;
};

export function splitMailboxList(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];

	const parts: string[] = [];
	let current = "";
	let inQuotes = false;
	let escaped = false;
	let angleDepth = 0;
	let parenDepth = 0;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\" && inQuotes) {
			current += ch;
			escaped = true;
			continue;
		}

		if (ch === '"') {
			inQuotes = !inQuotes;
			current += ch;
			continue;
		}

		if (!inQuotes) {
			if (ch === "<") {
				angleDepth++;
			} else if (ch === ">" && angleDepth > 0) {
				angleDepth--;
			} else if (ch === "(") {
				parenDepth++;
			} else if (ch === ")" && parenDepth > 0) {
				parenDepth--;
			} else if (ch === "," && angleDepth === 0 && parenDepth === 0) {
				const trimmed = current.trim();
				if (trimmed) parts.push(trimmed);
				current = "";
				continue;
			}
		}

		current += ch;
	}

	const trailing = current.trim();
	if (trailing) parts.push(trailing);

	return parts;
}

export function parseMailbox(raw: string | undefined): Mailbox | null {
	if (!raw?.trim()) return null;
	const trimmed = raw.trim();
	const angled = trimmed.match(/^(.*)<([^>]+)>\s*$/);
	if (angled) {
		const rawName = angled[1].trim();
		const unquoted =
			rawName.startsWith('"') && rawName.endsWith('"') && rawName.length >= 2
				? rawName.slice(1, -1).replace(/\\(.)/g, "$1")
				: rawName;
		const name = unquoted.trim() || null;
		return { name, email: angled[2].trim() };
	}
	if (trimmed.includes("@")) return { name: null, email: trimmed };
	return { name: trimmed, email: "" };
}

export function parseMailboxList(raw: string | undefined): Mailbox[] {
	return splitMailboxList(raw)
		.map((part) => parseMailbox(part))
		.filter((box): box is Mailbox => box !== null);
}

export function consumeJsonFlag(args: string[]): { json: boolean; args: string[] } {
	let json = false;
	const next: string[] = [];
	let endOfOptions = false;

	for (const arg of args) {
		if (!endOfOptions && arg === "--") {
			endOfOptions = true;
			next.push(arg);
			continue;
		}
		if (!endOfOptions && arg === "--json") {
			json = true;
		} else {
			next.push(arg);
		}
	}
	return { json, args: next };
}
