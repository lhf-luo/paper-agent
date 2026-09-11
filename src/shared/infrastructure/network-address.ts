import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressResolver = (hostname: string) => Promise<Array<{ address: string }>>;

export function isPrivateIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
	const [a, b, c] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

export function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 4) return isPrivateIpv4(address);
	const normalized = address.toLowerCase();
	if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab]/.test(normalized) ||
		normalized.startsWith("ff") ||
		normalized.startsWith("2001:db8:")
	);
}

const defaultResolver: AddressResolver = async (hostname) =>
	(await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({ address: entry.address }));

export async function assertPublicUrl(url: URL, resolver: AddressResolver = defaultResolver): Promise<string[]> {
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Only http:// and https:// URLs are allowed");
	}
	if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
	const hostname = url.hostname.toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	) {
		throw new Error(`Private hostname is not allowed: ${hostname}`);
	}
	if (isIP(hostname)) {
		if (isPrivateAddress(hostname)) throw new Error(`Private or reserved address is not allowed: ${hostname}`);
		return [hostname];
	}
	const addresses = await resolver(hostname);
	if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw new Error(`Hostname does not resolve exclusively to public addresses: ${hostname}`);
	}
	return [...new Set(addresses.map((entry) => entry.address))];
}
