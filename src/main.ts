import path from "node:path";

import { config } from "./config.ts";
import { secrets } from "./secrets.ts";

export type Handler =
	| {
		domain: string;
		origin?: never;
		handle: (req: Request) => Response | Promise<Response>;
	}
	| {
		origin: string;
		domain?: never;
		handle: (req: Request) => Response | Promise<Response>;
	};

const handlers = new Map<string, Handler>();

const loadHandlers = async (directory = "") => {
	try {
		for await (const entry of Deno.readDir(path.join("./src/modules", directory))) {
			const entryPath = path.join(directory, entry.name);
			const fullEntryPath = path.join("./src/modules", entryPath);

			let isDirectory = entry.isDirectory;
			let isFile = entry.isFile;

			if (entry.isSymlink) {
				try {
					const stat = await Deno.stat(fullEntryPath);
					isDirectory = stat.isDirectory;
					isFile = stat.isFile;
				} catch (error) {
					console.warn(`Could not stat symlink target for ${fullEntryPath}:`, error);
					continue;
				}
			}

			if (isDirectory) await loadHandlers(entryPath);
			else if (isFile && entry.name.endsWith(".ts")) {
				const filePath = directory ? `${directory}/${entry.name}` : entry.name;

				try {
					const importedModule = await import(`./modules/${filePath}`);

					if (importedModule.handler) {
						const handler = importedModule.handler as Handler;
						const handlerKey = "domain" in handler ? handler.domain : handler.origin;

						if (handlerKey && typeof handler.handle === "function") {
							if (handlers.has(handlerKey)) {
								console.warn(`Duplicate handler for key "${handlerKey}" found in module "${filePath}". Skipping.`);
								continue;
							}

							handlers.set(handlerKey, handler);
							console.log(`Loaded handler for key: ${handlerKey}`);
						}
					}
				} catch (error) {
					console.error(`Failed to load module ${filePath}:`, error);
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
		const origin = req.headers.get("origin") || "";
		console.info(`Incoming request for host: "${hostDomain}"`);

		const handler = handlers.get(hostDomain) ?? handlers.get(origin);
		if (handler) {
			try {
				return await handler.handle(req);
			} catch (error) {
				console.error(`Error while handling request for "${hostDomain || origin}":`, error);
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