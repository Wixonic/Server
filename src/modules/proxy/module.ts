import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { TLSSocket } from "node:tls";
import { encodeBase64 } from "@std/encoding";

import { config } from "../../config.ts";
import { user, password } from "./secrets.ts";

export const startProxyFacade = (cert: string, key: string, internalPort: number) => {
	const expectedAuth = `Basic ${encodeBase64(`${user}:${password}`)}`;

	const getHeaderValue = (header: string | string[] | undefined): string => {
		if (!header) return "";
		if (Array.isArray(header)) return header[0] || "";
		return header;
	};

	const isAuthorized = (authHeader: string | string[] | undefined): boolean => {
		const auth = getHeaderValue(authHeader).trim();
		if (!auth || !auth.toLowerCase().startsWith("basic ")) return false;
		return auth === expectedAuth;
	};

	const handleConnect = (req: http.IncomingMessage, clientSocket: net.Socket, head: Uint8Array) => {
		const target = req.url || "";
		const auth = req.headers["proxy-authorization"];

		console.info(`[Proxy] CONNECT request: ${target}`);

		if (!isAuthorized(auth)) {
			console.warn(`[Proxy] Unauthorized CONNECT to ${target}`);
			clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n");
			clientSocket.write('Proxy-Authenticate: Basic realm="Wixonic Proxy"\r\n\r\n');
			clientSocket.end();
			return;
		}

		if (!target.includes(":")) {
			console.warn(`[Proxy] Invalid CONNECT target: ${target || "[EMPTY]"}`);
			clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			clientSocket.end();
			return;
		}

		const [hostname, portStr] = target.split(":");
		const port = Number.parseInt(portStr, 10) || 443;

		if (!hostname || Number.isNaN(port)) {
			console.warn(`[Proxy] Invalid CONNECT host/port: ${target}`);
			clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			clientSocket.end();
			return;
		}

		const serverSocket = net.connect(port, hostname, () => {
			console.info(`[Proxy] Tunnel established to ${hostname}:${port}`);
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head && head.length > 0) serverSocket.write(head);
			serverSocket.pipe(clientSocket);
			clientSocket.pipe(serverSocket);
		});

		serverSocket.on("error", (err) => {
			console.error(`[Proxy] Tunnel error to ${hostname}:`, err.message);
			if (!clientSocket.destroyed) clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			clientSocket.end();
		});
		clientSocket.on("error", () => serverSocket.end());
	};

	const server = https.createServer({ key, cert }, (req, res) => {
		// DÉTECTION D'HÔTE ULTRA-ROBUSTE
		let host = "";
		const method = req.method || "GET";
		const url = req.url || "/";
		const auth = req.headers["proxy-authorization"];
		const hasProxyAuth = !!getHeaderValue(auth);
		const hasProxyConnection = !!getHeaderValue(req.headers["proxy-connection"]);
		const isAbsoluteUrl = url.startsWith("http://") || url.startsWith("https://");
		const isProxyTraffic = method === "CONNECT" || isAbsoluteUrl || hasProxyAuth || hasProxyConnection;

		// 1. Essayer l'URL complète (cas typique du proxy HTTP)
		if (req.url?.startsWith("http")) {
			try { host = new URL(req.url).hostname; } catch { /* ignore */ }
		}

		// 2. Essayer les headers standards (H1 et H2)
		if (!host) {
			host = (req.headers["host"] || req.headers[":authority"] || "").toString().split(":")[0];
		}

		// 3. Essayer le SNI du certificat
		if (!host) {
			const tlsSocket = req.socket as TLSSocket & { _servername?: string };
			host = tlsSocket.servername || tlsSocket._servername || "";
		}

		if (!host && !isProxyTraffic) {
			host = "server.wixonic.fr";
		}

		console.info(`[Proxy] Incoming: ${method} ${host || "[EMPTY]"}${url}`);

		const isInternal = host.includes("wixonic.fr");

		// Nettoyage des headers
		const headers = { ...req.headers };
		delete headers["proxy-authorization"];
		Object.keys(headers).forEach(k => { if (k.startsWith(":")) delete headers[k]; });

		// CRUCIAL : On force l'hôte pour Deno
		if (host) headers["host"] = host;

		if (!isInternal && isProxyTraffic && !isAuthorized(auth)) {
			console.warn(`[Proxy] 407 Unauthorized for ${host || "unknown host"}`);
			res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Wixonic Proxy"' });
			res.end();
			return;
		}

		let targetHost = isInternal ? "127.0.0.1" : host;
		let targetPort = isInternal ? internalPort : 80;
		let targetPath = url || "/";
		let requestImpl: typeof http | typeof https = http;

		if (!isInternal && req.url?.startsWith("http")) {
			try {
				const parsedUrl = new URL(req.url);
				targetHost = parsedUrl.hostname;
				targetPort = parsedUrl.port
					? Number.parseInt(parsedUrl.port, 10)
					: parsedUrl.protocol === "https:"
						? 443
						: 80;
				targetPath = `${parsedUrl.pathname}${parsedUrl.search}`;
				requestImpl = parsedUrl.protocol === "https:" ? https : http;
				headers["host"] = parsedUrl.host;
			} catch (error) {
				console.warn(`[Proxy] Invalid absolute URL, using fallback routing: ${req.url}`, error);
			}
		}

		if (!isInternal && requestImpl === https && targetPort === 80) targetPort = 443;

		console.info(`[Proxy] Forwarding route=${isInternal ? "internal" : "external"} to ${targetHost}:${targetPort} (Host header: "${headers["host"]}")`);

		const proxyReq = requestImpl.request({
			hostname: targetHost,
			port: targetPort,
			path: targetPath,
			method: method,
			headers: headers
		}, (proxyRes) => {
			res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
			proxyRes.pipe(res);
		});

		req.pipe(proxyReq);
		proxyReq.on("error", (err) => {
			console.error(`[Proxy] Forward error:`, err.message);
			if (!res.headersSent) res.writeHead(502);
			res.end("Bad Gateway");
		});
	});

	// Log de connexion brute pour voir si macOS tente au moins de se connecter
	server.on("connection", (socket) => {
		const remoteAddress = (socket as net.Socket).remoteAddress || "unknown";
		console.log(`[Proxy] New TCP connection from ${remoteAddress}`);
	});

	server.on("connect", (req, clientSocket, head) => {
		handleConnect(req, clientSocket as net.Socket, head);
	});

	server.listen(config.port.facade, "0.0.0.0", () => {
		console.log(`Proxy listening on 0.0.0.0:${config.port.facade}`);
	});
};

import type { Handler } from "../../main.ts";

export const proxy: Handler = {
	domain: "proxy.wixonic.fr",
	handle: () => new Response("Proxy is running on the TCP layer")
};