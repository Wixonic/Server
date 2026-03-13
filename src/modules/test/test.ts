import type { Handler } from "../../types.ts";

export const test: Handler = {
	domain: "localhost:2005",

	handle(_req: Request) {
		return new Response("Hello from test");
	}
};