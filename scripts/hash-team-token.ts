import { randomBytes } from "node:crypto";
import { hashTeamToken } from "../src/team-corpus-server.ts";

const token = process.argv[2] ?? randomBytes(32).toString("base64url");
console.log(JSON.stringify({ token, tokenSha256: hashTeamToken(token) }, null, 2));
