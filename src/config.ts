const isDevEnvironment = Deno.env.get("CLIENT") === "dev";

export const config = {
	isDevEnvironment,
	fallback: isDevEnvironment ? "http://localhost:1200" : "https://wixonic.fr",
	secure: !isDevEnvironment
};