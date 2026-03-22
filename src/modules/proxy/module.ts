import http from "node:http";
import https from "node:https";
import net from "node:net";
import { encodeBase64 } from "@std/encoding";

import { config } from "../../config.ts";
import { user, password } from "./secrets.ts";

export const startProxyFacade = (cert: string, key: string, internalPort: number) => {
	const expectedAuth = `Basic ${encodeBase64(`${user}:${password}`)}`;

	const handleConnect = (req: http.IncomingMessage, clientSocket: net.Socket, head: Uint8Array) => {
		const host = req.url || "unknown";
		
		if (req.headers["proxy-authorization"] !== expectedAuth) {
			console.warn(`[Proxy] Unauthorized CONNECT attempt to ${host}`);
			clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n");
			clientSocket.write('Proxy-Authenticate: Basic realm="Wixonic Proxy"\r\n\r\n');
			clientSocket.end();
			return;
		}

		const [hostname, portStr] = host.split(":");
		if (!hostname) {
			clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			clientSocket.end();
			return;
		}

		const port = Number.parseInt(portStr, 10) || 443;
		console.info(`[Proxy] CONNECT tunnel established to ${hostname}:${port}`);
		
		const serverSocket = net.connect(port, hostname, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) serverSocket.write(head);
			serverSocket.pipe(clientSocket);
			clientSocket.pipe(serverSocket);
		});

		serverSocket.on("error", (error) => {
			console.error(`[Proxy] CONNECT upstream error to ${hostname}:${port}:`, error.message);
			clientSocket.end();
		});
		clientSocket.on("error", () => serverSocket.end());
	};

	const server = https.createServer({
		key,
		cert
	}, (req, res) => {
		const host = req.headers["host"] || "";
		const method = req.method;
		const url = req.url;

		if (method === "CONNECT") {
			handleConnect(req, req.socket as net.Socket, new Uint8Array(0));
			return;
		}

		const isInternal = host.includes("wixonic.fr");

		if (!isInternal && req.headers["proxy-authorization"] !== expectedAuth) {
			console.warn(`[Proxy] Unauthorized ${method} attempt to ${host}${url}`);
			res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Wixonic Proxy"' });
			res.end();
			return;
		}

		if (isInternal) {
			console.info(`[Proxy] Internal route: ${method} ${host}${url}`);
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
				console.error(`[Proxy] Failed to forward to internal server:`, error.message);
				if (!res.headersSent) res.writeHead(502);
				res.end("Bad Gateway Internal");
			});
		} else {
			console.info(`[Proxy] External route: ${method} ${host}${url}`);
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
					console.error(`[Proxy] External proxy error to ${host}:`, error.message);
					if (!res.headersSent) res.writeHead(502);
					res.end("Bad Gateway External");
				});
			} catch (error) {
				console.error(`[Proxy] Invalid URL: ${url}`);
				res.writeHead(400);
				res.end("Invalid URL");
			}
		}
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