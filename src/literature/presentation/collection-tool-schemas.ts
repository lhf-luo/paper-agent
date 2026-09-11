import { Type } from "typebox";

export const providerSchema = Type.Union([
	Type.Literal("arxiv"),
	Type.Literal("acl_anthology"),
	Type.Literal("openalex"),
	Type.Literal("crossref"),
	Type.Literal("semanticscholar"),
	Type.Literal("dblp"),
	Type.Literal("core"),
	Type.Literal("exa"),
	Type.Literal("usenix"),
]);

export const scopeSchema = Type.Union([Type.Literal("personal"), Type.Literal("team")]);
export const modeSchema = Type.Union([Type.Literal("once"), Type.Literal("persistent")]);
