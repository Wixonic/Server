export interface Handler {
	domain: string;
	handle: (req: Request) => Response | Promise<Response>;
};