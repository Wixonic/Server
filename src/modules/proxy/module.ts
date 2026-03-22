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

		console.info(`[Proxy] CONNECT request: ${target}`);

		if (auth !== expectedAuth) {
			console.warn(`[Proxy] Unauthorized CONNECT to ${target}`);
			clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n");
			clientSocket.write('Proxy-Authenticate: Basic realm="Wixonic Proxy"\r\n\r\n');
			clientSocket.end();
			return;
		}

		const [hostname, portStr] = target.split(":");
		const port = Number.parseInt(portStr, 10) || 443;

		const serverSocket = net.connect(port, hostname, () => {
			console.info(`[Proxy] Tunnel established to ${hostname}:${port}`);
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head && head.length > 0) serverSocket.write(head);
			serverSocket.pipe(clientSocket);
			clientSocket.pipe(serverSocket);
		});

		serverSocket.on("error", (err) => {
			console.error(`[Proxy] Tunnel error to ${hostname}:`, err.message);
			clientSocket.end();
		});
		clientSocket.on("error", () => serverSocket.end());
	};

	const server = https.createServer({
		key,
		cert,
		// Pour macOS, il est parfois nécessaire d'être explicite sur le protocole supporté
		ALPNProtocols: ["http/1.1"]
	}, (req, res) => {
		// Log immédiat pour debug
		const rawHost = (req.headers["host"] || req.headers[":authority"] || "").toString();
		const cleanHost = rawHost.split(":")[0]; // On enlève le port pour Deno
		const method = req.method;
		const url = req.url;
		const auth = req.headers["proxy-authorization"];

		if (method === "CONNECT") {
			handleConnect(req, req.socket as net.Socket, new Uint8Array(0));
			return;
		}

		const isInternal = cleanHost.includes("wixonic.fr") || cleanHost === "";
		console.info(`[Proxy] Incoming: ${method} ${cleanHost}${url} (Internal: ${isInternal})`);

		// Nettoyage complet des headers pour éviter les conflits H1/H2
		const headers = { ...req.headers };
		delete headers["proxy-authorization"];
		Object.keys(headers).forEach(k => { if (k.startsWith(":")) delete headers[k]; });
		
		// Forcer l'hôte propre (sans le port) pour que Deno le reconnaisse
		if (cleanHost) headers["host"] = cleanHost;

		if (!isInternal && auth !== expectedAuth) {
			console.warn(`[Proxy] 407 Unauthorized for ${cleanHost}`);
			res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Wixonic Proxy"' });
			res.end();
			return;
		}

		const targetPort = isInternal ? internalPort : 80;
		const targetHost = isInternal ? "127.0.0.1" : cleanHost;

		console.info(`[Proxy] Forwarding ${method} to ${targetHost}:${targetPort} with host "${cleanHost}"`);

		const proxyReq = http.request({
			hostname: targetHost,
			port: targetPort,
			path: url,
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