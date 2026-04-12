import type { Handler } from "../../main.ts";

export const handler: Handler = {
	domain: "server.wixonic.fr",
	handle: () => new Response("Hi!")
};