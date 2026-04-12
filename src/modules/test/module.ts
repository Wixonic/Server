import { config } from "../../config.ts";
import type { Handler } from "../../main.ts";

export const handler: Handler = {
	domain: config.isDevEnvironment ? "localhost:1200" : "server.wixonic.fr",
	handle: () => new Response("Hi!")
};