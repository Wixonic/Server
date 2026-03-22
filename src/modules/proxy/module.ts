import http from "node:http";
import https from "node:https";
import net from "node:net";
import { encodeBase64 } from "@std/encoding";

import { config } from "../../config.ts";
import { user, password } from "./secrets.ts";

export const startProxyFacade = (cert: string, key: string, internalPort: number) => {
	const expectedAuth = `Basic ${encodeBase64(`${user}:${password}`)}`;

	const handleConnect = (req: http.IncomingMessage, clientSocket: net.Socket, head: Uint8Array) => {
		const target = req.url || "unknown";
		const auth = req.headers["proxy-authorization"];

		console.info(`[Proxy] CONNECT request for: ${target}`);

		if (auth !== expectedAuth) {
			console.warn(`[Proxy] Unauthorized CONNECT to ${target}`);
			clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n");
			clientSocket.write('Proxy-Authenticate: Basic realm="Wixonic Proxy"\r\n\r\n');
			clientSocket.end();
			return;
		}

		const [hostname, portStr] = target.split(":");
		if (!hostname) {
			clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			clientSocket.end();
			return;
		}

		const port = Number.parseInt(portStr, 10) || 443;
		console.info(`[Proxy] Tunneling to ${hostname}:${port}...`);
		
		const serverSocket = net.connect(port, hostname, () => {
			console.info(`[Proxy] Connected to ${hostname}:${port}`);
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head && head.length > 0) serverSocket.write(head);
			serverSocket.pipe(clientSocket);
			clientSocket.pipe(serverSocket);
		});

		serverSocket.on("error", (error) => {
			console.error(`[Proxy] Upstream error (${hostname}): ${error.message}`);
			clientSocket.end();
		});
		clientSocket.on("error", () => serverSocket.end());
	};

	const server = https.createServer({
		key,
		cert,
		// Désactivons temporairement le forçage ALPN pour voir si Deno gère mieux le H1/H2 mixte
	}, (req, res) => {
		// DÉTECTION D'HÔTE ULTRA-ROBUSTE
		const host = (
			req.headers["host"] || 
			req.headers[":authority"] || 
			(req.socket as any).servername || 
			(req.socket as any)._servername || 
			""
		).toString();
		
		const method = req.method;
		const url = req.url;
		const auth = req.headers["proxy-authorization"];

		// Debug: on log tous les headers si l'hôte est vide
		if (!host) {
			console.log("[Proxy] DEBUG Headers:", JSON.stringify(req.headers));
		}

		if (method === "CONNECT") {
			handleConnect(req, req.socket as net.Socket, new Uint8Array(0));
			return;
		}

		// Un domaine est interne s'il contient wixonic.fr OU si l'hôte est vide (sécurité pour tes tests)
		const isInternal = host.includes("wixonic.fr") || host === "";
		
		console.info(`[Proxy] ${method} ${host || "[EMPTY HOST]"}${url} (Internal: ${isInternal})`);

		if (!isInternal && auth !== expectedAuth) {
			console.warn(`[Proxy] 407 Unauthorized for external host: ${host}`);
			res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Wixonic Proxy"' });
			res.end();
			return;
		}

		if (isInternal) {
			console.info(`[Proxy] Forwarding to internal Deno server...`);
			const proxyRequest = http.request({
				hostname: "127.0.0.1",
				port: internalPort,
				path: url,
				method: method,
				headers: req.headers
			}, (proxyRes) => {
				res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
				proxyRes.pipe(res);
			});

			req.pipe(proxyRequest);
			proxyRequest.on("error", (error) => {
				console.error(`[Proxy] Internal forward error: ${error.message}`);
				if (!res.headersSent) res.writeHead(502);
				res.end("Bad Gateway Internal");
			});
		} else {
			console.info(`[Proxy] Fetching external resource: ${host}${url}`);
			try {
				const targetUrl = new URL(url!, `http://${host}`);
				const externalReq = http.request({
					hostname: targetUrl.hostname,
					port: targetUrl.port || 80,
					path: targetUrl.pathname + targetUrl.search,
					method: method,
					headers: req.headers
				}, (externalRes) => {
					res.writeHead(externalRes.statusCode || 200, externalRes.headers);
					externalRes.pipe(res);
				});

				req.pipe(externalReq);
				externalReq.on("error", (error) => {
					console.error(`[Proxy] External forward error: ${error.message}`);
					if (!res.headersSent) res.writeHead(502);
					res.end("Bad Gateway External");
				});
			} catch (error) {
				console.error(`[Proxy] URL error: ${error.message}`);
				res.writeHead(400);
				res.end("Invalid URL");
			}
		}
	});

	// Écouter explicitement l'événement 'connect' pour le proxying TLS
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