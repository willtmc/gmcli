export interface EmailAccount {
	email: string;
	oauth2: {
		// clientId / clientSecret are intentionally optional. New accounts created
		// after the Doppler migration do not persist these fields — they're loaded
		// from process.env (GMCLI_CLIENT_ID / GMCLI_CLIENT_SECRET) at runtime.
		// Older accounts.json records may still contain them; AccountStorage
		// strips them on next save.
		clientId?: string;
		clientSecret?: string;
		refreshToken: string;
		accessToken?: string;
	};
}
