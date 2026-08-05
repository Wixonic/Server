import path from "node:path";

import { config } from "./config.ts";
import { secrets } from "./secrets.ts";

export type Handler = {
	domain: string;
	origin?: string;
	path?: string;
	handle: (req: Request) => Response | Promise<Response>;
};

const handlers: Handler[] = [];

const loadHandlers = async (baseDir: string, subDirectory = "") => {
	try {
		const targetDir = path.join(baseDir, subDirectory);
		for await (const entry of Deno.readDir(targetDir)) {
			const entryPath = subDirectory ? path.join(subDirectory, entry.name) : entry.name;
			const fullEntryPath = path.join(baseDir, entryPath);

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

			if (isDirectory) await loadHandlers(baseDir, entryPath);
			else if (isFile && entry.name.endsWith(".ts")) {
				try {
					const resolvedPath = await Deno.realPath(fullEntryPath).catch(() => path.resolve(fullEntryPath));
					const importedModule = await import(new URL(`file://${resolvedPath}`).href);

					if (importedModule.handler) {
						const handler = importedModule.handler as Handler;

						if (handler.domain && typeof handler.handle === "function") {
							const isDuplicate = handlers.some((existingHandler) => {
								return existingHandler.domain === handler.domain && existingHandler.origin === handler.origin && (existingHandler.path ?? "") === (handler.path ?? "");
							});

							if (isDuplicate) {
								console.warn(`Duplicate handler for domain "${handler.domain}" and path "${handler.path ?? ""}" found in module "${entryPath}". Skipping.`);
								continue;
							}

							handlers.push(handler);
							console.log(`Loaded handler for domain: ${handler.domain}${handler.origin ? ` (origin: ${handler.origin})` : ""}${handler.path ? ` (path: ${handler.path})` : ""}`);
						}
					}
				} catch (error) {
					console.error(`Failed to load module ${entryPath}:`, error);
				}
			}
		}
	} catch (error) {
		if (!(error instanceof Deno.errors.NotFound)) {
			console.error(`Error reading modules directory ${baseDir}:`, error);
		}
	}
};

const normalizeHost = (host: string) => host.replace(/^127\.0\.0\.1/, "localhost");

const normalizePath = (pathname: string) => pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

const withCors = (res: Response, origin: string, reqHeaders?: string | null) => {
	const headers = new Headers(res.headers);
	if (origin) {
		headers.set("Access-Control-Allow-Origin", origin);
		headers.set("Access-Control-Allow-Credentials", "true");
	} else headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
	headers.set("Access-Control-Allow-Headers", reqHeaders || "*");
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

const main = async () => {
	try {
		await import("../WixiBot/src/main.ts");
		await loadHandlers("../WixiBot/src/modules");
	} catch (_error) {
		console.warn("WixiBot module not found on disk or failed to start. Running Server standalone.");
	}

	await loadHandlers("./src/modules");

	const mainHandler = async (req: Request): Promise<Response> => {
		const hostDomain = req.headers.get("host") || "";
		const origin = req.headers.get("origin") || "";
		const reqHeaders = req.headers.get("access-control-request-headers");
		const cleanOrigin = origin.replace(/^https?:\/\//, "");
		const pathname = new URL(req.url).pathname;
		console.info(`Incoming request for host: "${hostDomain}", origin: "${origin}", path: "${pathname}"`);

		const domainHandlers = handlers.filter((handler) => {
			const cleanHost = hostDomain.replace(/^https?:\/\//, "");
			const matchesDomain = handler.domain === hostDomain || handler.domain === cleanHost || normalizeHost(handler.domain) === normalizeHost(cleanHost);
			if (!matchesDomain) return false;

			if (!handler.origin) {
				if (origin) return false;
			} else if (handler.origin !== "*") {
				if (!origin) return false;
				const normOrigin = normalizeHost(handler.origin);
				const normCleanOrigin = normalizeHost(cleanOrigin);
				const matchesOrigin = handler.origin === origin || handler.origin === cleanOrigin || normOrigin === normCleanOrigin;
				if (!matchesOrigin) return false;
			}

			return true;
		});

		let handler = domainHandlers.find((h) => h.path && !h.path.endsWith("*") && normalizePath(h.path) === normalizePath(pathname));

		if (!handler) {
			handler = domainHandlers.find((h) => {
				if (!h.path || !h.path.endsWith("*")) return false;
				const prefix = h.path.slice(0, -1);
				return pathname.startsWith(prefix) || pathname === prefix.slice(0, -1);
			});
		}

		if (!handler) handler = domainHandlers.find((h) => !h.path);

		if (req.method === "OPTIONS") {
			if (handler) return withCors(new Response(null, { status: 204 }), origin, reqHeaders);
			return withCors(new Response("Method Not Allowed", { status: 405 }), origin, reqHeaders);
		}

		if (handler) {
			try {
				const response = await handler.handle(req);
				return withCors(response, origin, reqHeaders);
			} catch (error) {
				console.error(`Error while handling request for "${hostDomain || origin}${pathname}":`, error);
				return withCors(new Response("Internal Server Error", { status: 500 }), origin, reqHeaders);
			}
		}

		console.warn(`No handler found for "${hostDomain}${pathname}", redirecting to fallback.`);
		return withCors(Response.redirect(config.fallback, 302), origin, reqHeaders);
	};

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
			port: 1200
		}, mainHandler);
	} else {
		Deno.serve({
			port: 1200
		}, mainHandler);
	}
};

main();