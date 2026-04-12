import { config } from "./config.ts";
import { secrets } from "./secrets.ts";

export interface Handler {
	domain: string;
	handle: (req: Request) => Response | Promise<Response>;
}

const handlers = new Map<string, Handler>();

const loadHandlers = async () => {
	try {
		for await (const entry of Deno.readDir("./src/modules")) {
			if (entry.isDirectory) {
				try {
					const importedModule = await import(`./modules/${entry.name}/module.ts`);

					if (importedModule.handler) {
						const handler = importedModule.handler as Handler;

						if (handler.domain && typeof handler.handle === "function") {
							if (handlers.has(handler.domain)) {
								console.warn(`Duplicate handler for domain "${handler.domain}" found in module "${entry.name}". Skipping.`);
								continue;
							}

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
	await loadHandlers();

	const mainHandler = async (req: Request): Promise<Response> => {
		const hostDomain = req.headers.get("host") || "";
		console.info(`Incoming request for host: "${hostDomain}"`);

		if (hostDomain && handlers.has(hostDomain)) {
			try {
				return await handlers.get(hostDomain)!.handle(req);
			} catch (error) {
				console.error(`Error while handling request for "${hostDomain}":`, error);
				return new Response("Internal Server Error", { status: 500 });
			}
		}

		console.warn(`No handler found for "${hostDomain}", redirecting to fallback.`);
		return Response.redirect(config.fallback, 302);
	}

	if (config.secure) {
		let cert: string;
		let key: string;
		try {
			cert = await Deno.readTextFile(secrets.ssl.certPath);
			key = await Deno.readTextFile(secrets.ssl.keyPath);
		} catch (error) {
			console.error("Failed to read SSL certificates.", error);
			Deno.exit(1);
		}

		Deno.serve({
			cert,
			key,
			port: config.port
		}, mainHandler);
	} else {
		Deno.serve({
			port: config.port
		}, mainHandler);
	}
};

main();