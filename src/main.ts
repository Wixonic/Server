import { config } from "./config.ts";
import { secrets } from "./secrets.ts";
import { startProxyFacade, proxy as proxyHandler } from "./modules/proxy/module.ts";

export interface Handler {
	domain: string;
	handle: (req: Request) => Response | Promise<Response>;
}

const handlers = new Map<string, Handler>();

const loadHandlers = async () => {
	try {
		for await (const entry of Deno.readDir("./src/modules")) {
			if (entry.isDirectory && entry.name !== "proxy") {
				try {
					const importedModule = await import(`./modules/${entry.name}/module.ts`);

					if (importedModule[entry.name]) {
						const handler = importedModule[entry.name] as Partial<Handler>;

						if (handler?.domain && typeof handler.handle === "function") {
							handlers.set(handler.domain, handler as Handler);
							console.log(`Loaded handler for domain: ${handler.domain}`);
						}
					}
				} catch (error) {
					console.error(`Failed to load module ${entry.name}:`, error);
				}
			}
		}
	} catch (error) {
		console.error("Error reading modules directory:", error);
	}
};

const main = async () => {
	handlers.set(proxyHandler.domain, proxyHandler);
	await loadHandlers();

	let cert: string;
	let key: string;

	try {
		cert = await Deno.readTextFile(secrets.ssl.certPath);
		key = await Deno.readTextFile(secrets.ssl.keyPath);
	} catch (error) {
		console.error("Failed to read SSL certificates.", error);
		Deno.exit(1);
	}

	const handler = async (req: Request): Promise<Response> => {
		const hostHeader = req.headers.get("host") || "";
		console.info(`[Deno] Incoming request for host: "${hostHeader}"`);

		if (hostHeader && handlers.has(hostHeader)) return await handlers.get(hostHeader)!.handle(req);

		console.warn(`[Deno] No handler found for "${hostHeader}", redirecting to fallback.`);
		const fallbackUrl = Deno.env.get("CLIENT") === "dev" ? config.fallback.dev : config.fallback.prod;
		return Response.redirect(fallbackUrl, 302);
	};

	Deno.serve({
		hostname: "127.0.0.1",
		port: config.port.internal
	}, handler);
	console.info(`Deno server listening on 127.0.0.1:${config.port.internal}`);

	startProxyFacade(cert, key, config.port.internal);
};

main();