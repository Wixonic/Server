import { config } from "./config.ts";
import { secrets } from "./secrets.ts";
import type { Handler } from "./types.ts";

const handlers = new Map<string, Handler>();

const loadHandlers = async () => {
	const modulesDir = "./src/modules";

	try {
		for await (const dirEntry of Deno.readDir(modulesDir)) {
			if (dirEntry.isDirectory) {
				const moduleName = dirEntry.name;
				try {
					const importedModule = await import(`./modules/${moduleName}/${moduleName}.ts`);

					if (importedModule[moduleName]) {
						const handler = importedModule[moduleName] as Partial<Handler>;
						if (handler?.domain && typeof handler.handle === "function") {
							handlers.set(handler.domain, handler as Handler);
							console.log(`Loaded handler for domain: ${handler.domain}`);
						}
					}
				} catch (e) {
					console.error(`Failed to load module ${moduleName}:`, e);
				}
			}
		}
	} catch (e) {
		console.error("Error reading modules directory:", e);
	}
};

const main = async () => {
	await loadHandlers();

	let cert: string;
	let key: string;

	try {
		cert = await Deno.readTextFile(secrets.ssl.certPath);
		key = await Deno.readTextFile(secrets.ssl.keyPath);
	} catch (e) {
		console.error("Failed to read SSL certificates. Ensure they exist at the paths defined in secrets.ts.", e);
		Deno.exit(1);
	}

	const handler = async (req: Request): Promise<Response> => {
		const hostHeader = req.headers.get("host");

		if (hostHeader && handlers.has(hostHeader)) {
			return await handlers.get(hostHeader)!.handle(req);
		}

		const isDev = Deno.env.get("CLIENT") === "dev";
		const fallbackUrl = isDev ? config.fallback.dev : config.fallback.prod;
		return Response.redirect(fallbackUrl, 302);
	};

	Deno.serve({ cert, key }, handler);
};

main();