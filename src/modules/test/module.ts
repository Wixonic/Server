import type { Handler } from "../../main.ts";

export const test: Handler = {
	domain: "server.wixonic.fr",
	handle: () => new Response("Hi!")
};