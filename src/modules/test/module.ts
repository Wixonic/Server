import type { Handler } from "../../main.ts";

export const proxy: Handler = {
	domain: "server.wixonic.fr",
	handle: () => new Response("Hi!")
};