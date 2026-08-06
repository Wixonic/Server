const isDevEnvironment = Deno.env.get("CLIENT") === "dev";

export const config = {
	isDevEnvironment,
	fallback: isDevEnvironment ? "http://localhost:2005" : "https://wixonic.fr",
	port: 1200,
	secure: !isDevEnvironment
};