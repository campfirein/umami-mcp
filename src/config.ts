// Configuration: which Umami are we talking to, and how do we authenticate?
// Two mutually exclusive modes, both env-driven so no secret ever lands in a
// config file or on the command line:
//
//   Cloud        UMAMI_API_KEY set                → x-umami-api-key header
//   Self-hosted  UMAMI_USERNAME + UMAMI_PASSWORD  → POST /auth/login → bearer
//
// The API key path is preferred (it is Umami Cloud's first-class, read-only
// credential). We fail LOUD when neither mode is fully specified rather than
// silently starting a server that 401s on the first tool call.

/** The resolved connection + credentials, discriminated by auth mode. */
export type UmamiConfig =
	| { readonly mode: "cloud"; readonly base: string; readonly apiKey: string }
	| { readonly mode: "self-hosted"; readonly base: string; readonly username: string; readonly password: string };

/** Join a host and a path prefix into one base URL, tolerating stray slashes. */
function joinBase(host: string, apiPath: string): string {
	const cleanHost = host.replace(/\/+$/, "");
	if (apiPath.length === 0) return cleanHost;
	const cleanPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
	// Don't double up when the host already carries the prefix (e.g. someone
	// sets UMAMI_API_URL=https://api.umami.is/v1).
	return cleanHost.endsWith(cleanPath) ? cleanHost : `${cleanHost}${cleanPath}`;
}

/**
 * Build the {@link UmamiConfig} from the environment. Throws with actionable
 * guidance when the environment does not fully specify exactly one mode.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): UmamiConfig {
	const rawUrl = env.UMAMI_API_URL?.trim();
	const apiKey = env.UMAMI_API_KEY?.trim();
	const username = env.UMAMI_USERNAME?.trim();
	const password = env.UMAMI_PASSWORD?.trim();
	const apiPathOverride = env.UMAMI_API_PATH?.trim();

	if (apiKey !== undefined && apiKey.length > 0) {
		const host = rawUrl !== undefined && rawUrl.length > 0 ? rawUrl : "https://api.umami.is";
		return { mode: "cloud", base: joinBase(host, apiPathOverride ?? "/v1"), apiKey };
	}

	if (username !== undefined && username.length > 0 && password !== undefined && password.length > 0) {
		if (rawUrl === undefined || rawUrl.length === 0) {
			throw new Error("self-hosted mode needs UMAMI_API_URL (your Umami instance's base URL)");
		}
		return { mode: "self-hosted", base: joinBase(rawUrl, apiPathOverride ?? "/api"), username, password };
	}

	throw new Error(
		"Umami MCP is unconfigured. Set UMAMI_API_KEY (Umami Cloud) OR " +
			"UMAMI_USERNAME + UMAMI_PASSWORD + UMAMI_API_URL (self-hosted).",
	);
}
