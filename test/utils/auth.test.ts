import { describe, expect, it } from "vitest";
import { MissingCredentialsError, parseBasicAuth } from "../../src/utils/auth.js";

const encodeBasic = (user: string, pass: string): string => `Basic ${btoa(`${user}:${pass}`)}`;

describe("parseBasicAuth", () => {
  it("extracts the hatenaId from the Basic header", () => {
    const header = encodeBasic("example_user", "abc123");
    const creds = parseBasicAuth(header);
    expect(creds.hatenaId).toBe("example_user");
    expect(creds.authHeader).toBe(header);
  });

  it("accepts lowercase 'basic' and extra whitespace", () => {
    const raw = `  basic  ${btoa("user:pw")}  `;
    const creds = parseBasicAuth(raw);
    expect(creds.hatenaId).toBe("user");
    // authHeader is trimmed so it can be used directly in an outbound request.
    expect(creds.authHeader).toBe(raw.trim());
  });

  it("throws when the header is null/undefined/empty", () => {
    expect(() => parseBasicAuth(null)).toThrow(MissingCredentialsError);
    expect(() => parseBasicAuth(undefined)).toThrow(MissingCredentialsError);
    expect(() => parseBasicAuth("")).toThrow(MissingCredentialsError);
  });

  it("throws when the scheme is not Basic", () => {
    expect(() => parseBasicAuth("Bearer token")).toThrow(MissingCredentialsError);
  });

  it("throws on invalid base64", () => {
    expect(() => parseBasicAuth("Basic !!!not-base64!!!")).toThrow(/base64/);
  });

  it("throws when the decoded payload has no colon", () => {
    const b64 = btoa("no-colon-here");
    expect(() => parseBasicAuth(`Basic ${b64}`)).toThrow(/user:password/);
  });

  it("throws when the username is empty (leading colon)", () => {
    const b64 = btoa(":only-password");
    expect(() => parseBasicAuth(`Basic ${b64}`)).toThrow();
  });

  it("allows passwords that contain colons", () => {
    const header = encodeBasic("u", "a:b:c");
    const creds = parseBasicAuth(header);
    expect(creds.hatenaId).toBe("u");
  });

  it("does not return the password anywhere in the parsed object", () => {
    const header = encodeBasic("u", "super-secret");
    const creds = parseBasicAuth(header);
    expect(JSON.stringify(creds)).not.toContain("super-secret");
  });
});
