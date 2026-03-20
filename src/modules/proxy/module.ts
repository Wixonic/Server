import http from "node:http";
import https from "node:https";
import net from "node:net";
import { encodeBase64 } from "@std/encoding";

import { config } from "../../config.ts";
import { user, password } from "./secrets.ts";

export const startProxyFacade = (cert: string, key: string, internalPort: number) => {
	const handleConnect = (req: http.IncomingMessage, clientSocket: net.Socket, head: Uint8Array) => {
		const expectedAuth = `Basic ${encodeBase64(`${user}:${password}`)}`;

		if (req.headers["proxy-authorization"] !== expectedAuth) {
			clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n");
			clientSocket.write('Proxy-Authenticate: Basic realm="Wixonic Proxy"\r\n\r\n');
			clientSocket.end();
			return;
		}

		const [hostname, portStr] = (req.url || "").split(":");

		if (!hostname) {
			clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			clientSocket.end();
			return;
		}

		const port = Number.parseInt(portStr, 10) || 443;
		const serverSocket = net.connect(port, hostname, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) serverSocket.write(head);
			serverSocket.pipe(clientSocket);
			clientSocket.pipe(serverSocket);
		});

		serverSocket.on("error", (error) => {
			console.error(`CONNECT upstream error to ${hostname}:${port}`, error);
			clientSocket.end();
		});
		clientSocket.on("error", () => serverSocket.end());
	};

	const server = https.createServer({
		key,
		cert
	}, (req, res) => {
		if (req.method === "CONNECT") {
			handleConnect(req, req.socket as net.Socket, new Uint8Array(0));
			return;
		}

		const proxyRequest = http.request({
			hostname: "127.0.0.1",
			port: internalPort,
			path: req.url,
			method: req.method,
			headers: req.headers
		}, (proxyRes) => {
			res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
			proxyRes.pipe(res);
		});

		req.pipe(proxyRequest);
		proxyRequest.on("error", (error) => {
			console.error(`Failed to forward request to internal server 127.0.0.1:${internalPort}`, error);
			if (!res.headersSent) res.writeHead(502);
			res.end("Bad Gateway");
		});
	});

	server.on("connect", (req, clientSocket, head) => {
		handleConnect(req, clientSocket as net.Socket, head);
	});

	server.listen(config.port.facade, () => console.log(`Proxy listening on 127.0.0.1:${config.port.facade}`));
};

import type { Handler } from "../../main.ts";

export const proxy: Handler = {
	domain: "proxy.wixonic.fr",
	handle: () => new Response("Proxy is running on the TCP layer")
};