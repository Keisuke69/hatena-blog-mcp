import { describe, expect, it } from "vitest";
import { MissingCredentialsError, parseAuthHeader, parseBasicAuth } from "../../src/utils/auth.js";

const encodeBasic = (user: string, pass: string): string => `Basic ${btoa(`${user}:${pass}`)}`;
const encodeBearer = (user: string, pass: string): string => `Bearer ${btoa(`${user}:${pass}`)}`;

describe("parseAuthHeader — Basic scheme", () => {
  it("extracts the hatenaId from the Basic header", () => {
    const header = encodeBasic("example_user", "abc123");
    const creds = parseAuthHeader(header);
    expect(creds.hatenaId).toBe("example_user");
    expect(creds.authHeader).toBe(header);
  });

  it("accepts lowercase 'basic' and extra whitespace", () => {
    const raw = `  basic  ${btoa("user:pw")}  `;
    const creds = parseAuthHeader(raw);
    expect(creds.hatenaId).toBe("user");
    // authHeader is trimmed so it can be used directly in an outbound request.
    expect(creds.authHeader).toBe(raw.trim());
  });

  it("throws when the header is null/undefined/empty", () => {
    expect(() => parseAuthHeader(null)).toThrow(MissingCredentialsError);
    expect(() => parseAuthHeader(undefined)).toThrow(MissingCredentialsError);
    expect(() => parseAuthHeader("")).toThrow(MissingCredentialsError);
  });

  it("throws when the scheme is unsupported", () => {
    expect(() => parseAuthHeader("Digest token")).toThrow(MissingCredentialsError);
    expect(() => parseAuthHeader("token-without-scheme")).toThrow(MissingCredentialsError);
  });

  it("throws on invalid base64", () => {
    expect(() => parseAuthHeader("Basic !!!not-base64!!!")).toThrow(/base64/);
  });

  it("throws when the decoded payload has no colon", () => {
    const b64 = btoa("no-colon-here");
    expect(() => parseAuthHeader(`Basic ${b64}`)).toThrow(/user:password/);
  });

  it("throws when the username is empty (leading colon)", () => {
    const b64 = btoa(":only-password");
    expect(() => parseAuthHeader(`Basic ${b64}`)).toThrow();
  });

  it("allows passwords that contain colons", () => {
    const header = encodeBasic("u", "a:b:c");
    const creds = parseAuthHeader(header);
    expect(creds.hatenaId).toBe("u");
  });

  it("does not return the password anywhere in the parsed object", () => {
    const header = encodeBasic("u", "super-secret");
    const creds = parseAuthHeader(header);
    expect(JSON.stringify(creds)).not.toContain("super-secret");
  });
});

describe("parseAuthHeader — Bearer scheme (mcp-oauth-proxy etc.)", () => {
  it("accepts Bearer with base64(hatena_id:api_key) and rewrites to Basic", () => {
    const header = encodeBearer("example_user", "secret-key");
    const creds = parseAuthHeader(header);
    expect(creds.hatenaId).toBe("example_user");
    expect(creds.authHeader).toBe(`Basic ${btoa("example_user:secret-key")}`);
  });

  it("accepts Bearer with plain 'hatena_id:api_key' and rewrites to Basic", () => {
    const creds = parseAuthHeader("Bearer example_user:secret-key");
    expect(creds.hatenaId).toBe("example_user");
    expect(creds.authHeader).toBe(`Basic ${btoa("example_user:secret-key")}`);
  });

  it("accepts lowercase 'bearer' and trims surrounding whitespace", () => {
    const creds = parseAuthHeader("  bearer   user:pw  ");
    expect(creds.hatenaId).toBe("user");
    expect(creds.authHeader).toBe(`Basic ${btoa("user:pw")}`);
  });

  it("rejects Bearer without a colon (e.g. someone passed only the API key)", () => {
    expect(() => parseAuthHeader("Bearer just-the-api-key")).toThrow(/hatena_id:api_key/);
  });

  it("rejects Bearer where the base64 payload has no colon and no plain colon either", () => {
    const b64 = btoa("no-colon-here");
    expect(() => parseAuthHeader(`Bearer ${b64}`)).toThrow(/hatena_id:api_key/);
  });

  it("does not return the api key anywhere in the parsed object", () => {
    const header = encodeBearer("u", "super-secret");
    const creds = parseAuthHeader(header);
    expect(JSON.stringify(creds)).not.toContain("super-secret");
  });
});

describe("parseBasicAuth (legacy alias)", () => {
  it("still works as an alias for parseAuthHeader", () => {
    const creds = parseBasicAuth(encodeBasic("u", "pw"));
    expect(creds.hatenaId).toBe("u");
  });
});
