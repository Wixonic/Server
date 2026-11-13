import { readdir, readFile, realpath, stat as getStat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { config } from "./config.ts";
import { logger as defaultLogger, type Logger } from "./lib/logger.ts";
import { secrets } from "./secrets.ts";

export type { Logger };

export type Handler = {
	domain: string;
	origin?: string;
	path?: string;
	handle: (logger: Logger, request: Request) => Response | Promise<Response>;
};

let logger: Logger = defaultLogger;
const handlers: Handler[] = [];

const loadHandlers = async (baseDirectory: string, subDirectory = "") => {
	try {
		const targetDirectory = path.join(baseDirectory, subDirectory);
		for (const entry of await readdir(targetDirectory, { withFileTypes: true })) {
			const entryPath = subDirectory ? path.join(subDirectory, entry.name) : entry.name;
			const fullEntryPath = path.join(baseDirectory, entryPath);

			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const entryStat = await getStat(fullEntryPath);
					isDirectory = entryStat.isDirectory();
					isFile = entryStat.isFile();
				} catch (error) {
					logger.warn(`Could not stat symlink target for ${fullEntryPath}:`, error);
					continue;
				}
			}

			if (isDirectory) await loadHandlers(baseDirectory, entryPath);
			else if (isFile && entry.name.endsWith(".ts")) {
				try {
					const resolvedPath = await realpath(fullEntryPath).catch(() => path.resolve(fullEntryPath));
					const importedModule = await import(pathToFileURL(resolvedPath).href);

					if (importedModule.handler) {
						const handler = importedModule.handler as Handler;

						if (handler.domain && typeof handler.handle === "function") {
							const isDuplicate = handlers.some((existingHandler) => {
								return existingHandler.domain === handler.domain && existingHandler.origin === handler.origin && (existingHandler.path ?? "") === (handler.path ?? "");
							});

							if (isDuplicate) {
								logger.warn(`Duplicate handler for domain "${handler.domain}" and path "${handler.path ?? ""}" found in module "${entryPath}". Skipping.`);
								continue;
							}

							handlers.push(handler);
							logger.debug(`Loaded handler for domain: ${handler.domain}${handler.origin ? ` (origin: ${handler.origin})` : ""}${handler.path ? ` (path: ${handler.path})` : ""}`);
						}
					}
				} catch (error) {
					logger.error(`Failed to load module ${entryPath}:`, error);
				}
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.error(`Error reading modules directory ${baseDirectory}:`, error);
		}
	}
};

const isIpHost = (host: string) => {
	let hostname = host.replace(/^https?:\/\//, "");
	if (hostname.startsWith("[")) {
		const closingBracket = hostname.indexOf("]");
		if (closingBracket !== -1) hostname = hostname.slice(1, closingBracket);
	} else if (hostname.includes(":")) {
		const parts = hostname.split(":");
		if (parts.length === 2) hostname = parts[0];
	}
	return isIP(hostname) !== 0;
};

const normalizeHost = (host: string) => host.replace(/^127\.0\.0\.1/, "localhost");

const normalizePath = (pathname: string) => pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

const withCors = (response: Response, origin: string, requestHeaders?: string | null) => {
	const headers = new Headers(response.headers);
	if (origin) {
		headers.set("Access-Control-Allow-Origin", origin);
		headers.set("Access-Control-Allow-Credentials", "true");
	} else headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
	headers.set("Access-Control-Allow-Headers", requestHeaders || "*");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const main = async () => {
	const directory = import.meta.dirname ?? "";

	await loadHandlers(path.join(directory, "modules"));

	const mainHandler = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const hostDomain = request.headers.get("host") || url.host;
		const origin = request.headers.get("origin") || "";
		const requestHeaders = request.headers.get("access-control-request-headers");
		const cleanOrigin = origin.replace(/^https?:\/\//, "");
		const pathname = url.pathname;

		if (!config.isDevEnvironment && isIpHost(hostDomain)) {
			logger.debug(`Blocked request with IP host: "${hostDomain}", origin: "${origin}", path: "${pathname}"`);
			return withCors(new Response("Forbidden", { status: 403 }), origin, requestHeaders);
		}

		logger.info(`Incoming request for host: "${hostDomain}", origin: "${origin}", path: "${pathname}"`);

		const domainHandlers = handlers.filter((handler) => {
			const cleanHost = hostDomain.replace(/^https?:\/\//, "");
			const matchesDomain = handler.domain === hostDomain || handler.domain === cleanHost || normalizeHost(handler.domain) === normalizeHost(cleanHost);
			if (!matchesDomain) return false;

			if (!handler.origin) {
				if (origin) return false;
			} else if (handler.origin !== "*") {
				if (!origin) return false;
				const normalizedOrigin = normalizeHost(handler.origin);
				const normalizedCleanOrigin = normalizeHost(cleanOrigin);
				const matchesOrigin = handler.origin === origin || handler.origin === cleanOrigin || normalizedOrigin === normalizedCleanOrigin;
				if (!matchesOrigin) return false;
			}

			return true;
		});

		let handler = domainHandlers.find((handler) => handler.path && !handler.path.endsWith("*") && normalizePath(handler.path) === normalizePath(pathname));

		if (!handler) {
			handler = domainHandlers.find((handler) => {
				if (!handler.path || !handler.path.endsWith("*")) return false;
				const prefix = handler.path.slice(0, -1);
				return pathname.startsWith(prefix) || pathname === prefix.slice(0, -1);
			});
		}

		if (!handler) handler = domainHandlers.find((handler) => !handler.path);

		if (request.method === "OPTIONS") {
			if (handler) return withCors(new Response(null, { status: 204 }), origin, requestHeaders);
			else {
				logger.warn(`No handler found for request to "${hostDomain || origin}${pathname}". Method Not Allowed.`);
				return withCors(new Response("Method Not Allowed", { status: 405 }), origin, requestHeaders);
			}
		}

		if (handler) {
			try {
				const response = await handler.handle(logger, request);
				return withCors(response, origin, requestHeaders);
			} catch (error) {
				logger.error(`Error while handling request for "${hostDomain || origin}${pathname}":`, error);
				return withCors(new Response("Internal Server Error", { status: 500 }), origin, requestHeaders);
			}
		}

		logger.warn(`No handler found for "${hostDomain}${pathname}", redirecting to fallback.`);
		return withCors(Response.redirect(config.fallback, 302), origin, requestHeaders);
	};

	const ports = new Set<number>([config.port]);
	for (const handler of handlers) {
		const match = handler.domain.match(/:(\d+)$/);
		if (match) ports.add(parseInt(match[1], 10));
	}

	const listener = (request: IncomingMessage, response: ServerResponse) => {
		let webRequest: Request;
		try {
			const headers = new Headers();
			for (const [name, value] of Object.entries(request.headers)) {
				if (value === undefined) continue;
				if (Array.isArray(value)) for (const item of value) headers.append(name, item);
				else headers.set(name, value);
			}

			const method = request.method ?? "GET";
			const init: RequestInit & { duplex?: "half" } = { method, headers };

			if (method !== "GET" && method !== "HEAD") {
				init.body = Readable.toWeb(request) as unknown as RequestInit["body"];
				init.duplex = "half";
			}

			const host = request.headers.host ?? `localhost:${config.port}`;
			webRequest = new Request(new URL(request.url ?? "/", `${config.secure ? "https" : "http"}://${host}`), init);
		} catch (error) {
			logger.error("Failed to build request.", error);
			response.statusCode = 400;
			response.end("Bad Request");
			return;
		}

		mainHandler(webRequest).then(async (webResponse) => {
			response.statusCode = webResponse.status;
			if (webResponse.statusText) response.statusMessage = webResponse.statusText;

			webResponse.headers.forEach((value, name) => {
				if (name !== "set-cookie") response.setHeader(name, value);
			});

			const setCookies = webResponse.headers.getSetCookie();
			if (setCookies.length > 0) response.setHeader("set-cookie", setCookies);

			if (!webResponse.body || webResponse.status === 204 || webResponse.status === 304) response.end();
			else await pipeline(Readable.fromWeb(webResponse.body as Parameters<typeof Readable.fromWeb>[0]), response);
		}).catch((error) => {
			logger.error("Failed to write response.", error);
			if (response.headersSent) response.destroy();
			else {
				response.statusCode = 500;
				response.end("Internal Server Error");
			}
		});
	};

	if (config.secure) {
		let cert: string;
		let key: string;
		try {
			cert = await readFile(secrets.ssl.certPath, "utf8");
			key = await readFile(secrets.ssl.keyPath, "utf8");
		} catch (error) {
			logger.error("Failed to read SSL certificates.", error);
			process.exit(1);
		}

		for (const port of ports) {
			const server = createHttpsServer({ cert, key }, listener);
			server.on("error", (error) => logger.error(`Server error on port ${port}:`, error));
			server.listen(port, () => logger.info(`Listening on https://localhost:${port}`));
		}
	} else {
		for (const port of ports) {
			const server = createHttpServer(listener);
			server.on("error", (error) => logger.error(`Server error on port ${port}:`, error));
			server.listen(port, () => logger.info(`Listening on http://localhost:${port}`));
		}
	}
};

main();