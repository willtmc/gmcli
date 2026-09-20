export type Mailbox = {
	name: string | null;
	email: string;
};

export function parseMailbox(raw: string | undefined): Mailbox | null {
	if (!raw?.trim()) return null;
	const trimmed = raw.trim();
	const angled = trimmed.match(/^(.*)<([^>]+)>\s*$/);
	if (angled) {
		const name = angled[1].trim().replace(/^"|"$/g, "") || null;
		return { name, email: angled[2].trim() };
	}
	if (trimmed.includes("@")) return { name: null, email: trimmed };
	return { name: trimmed, email: "" };
}

export function parseMailboxList(raw: string | undefined): Mailbox[] {
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((part) => parseMailbox(part))
		.filter((box): box is Mailbox => box !== null);
}

export function consumeJsonFlag(args: string[]): { json: boolean; args: string[] } {
	let json = false;
	const next: string[] = [];
	for (const arg of args) {
		if (arg === "--json") json = true;
		else next.push(arg);
	}
	return { json, args: next };
}
