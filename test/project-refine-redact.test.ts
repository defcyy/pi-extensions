import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { redactText, redactValue } from "../pi-extension/project-refine/core/redact.ts";

// Fabricated locally: no credentials, environment values, or real key material.
// Build recognizable shapes at runtime so source/history scanners do not mistake
// complete credential-like literals for leaked secrets. Keep scanner protection on.
const fakeToken = (prefix: string, length = 36) => prefix + "A".repeat(length);
const fakeJwt = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "redaction-test-only", exp: 0 })).toString("base64url"),
  Buffer.from("not-a-cryptographic-signature").toString("base64url"),
].join(".");
const syntheticTokens = [
  fakeToken("sk-proj-"),
  fakeToken("ghp_"),
  fakeToken("github_pat_"),
  fakeToken("xoxb-"),
  fakeToken("AKIA", 16),
  fakeToken("AIza", 35),
  fakeToken("npm_"),
  fakeJwt,
];
const pemMarker = (edge: "BEGIN" | "END", format: "RSA" | "OPENSSH") =>
  ["-----", edge, " ", format, " PRIVATE KEY", "-----"].join("");

test("redacts synthetic token shapes without repeating them in warnings", () => {
  const result = redactText(syntheticTokens.join("\n"));
  for (const token of syntheticTokens) {
    assert.ok(!result.text.includes(token));
    assert.ok(!result.warnings.join(" ").includes(token));
  }
  assert.equal(result.redactions, syntheticTokens.length);
  assert.match(result.warnings.join(" "), /incomplete/);
  assert.match(result.warnings.join(" "), /review/i);
});

test("redacts complete and incomplete private keys, authorization and cookies", () => {
  const fakeBasicAuth = Buffer.from("fixture-user:fixture-password").toString("base64");
  const result = redactText(`${pemMarker("BEGIN", "RSA")}\nvery-private-material\n${pemMarker("END", "RSA")}\nAuthorization: Bearer super-secret-token\nProxy-Authorization: Basic ${fakeBasicAuth}\nCookie: session=top-secret\nSet-Cookie: secret=hidden; HttpOnly\n${pemMarker("BEGIN", "OPENSSH")}\nunfinished-private-material`);
  for (const secret of ["very-private-material", "super-secret-token", fakeBasicAuth, "top-secret", "hidden", "unfinished-private-material"]) assert.ok(!result.text.includes(secret));
  assert.match(result.text, /Authorization: \[REDACTED\]/);
});

test("redacts JSON, config, shell, camel-case assignments and URL secrets", () => {
  const result = redactText(`{"password":"with spaces", "client_secret": "jsonsecret", "apiKey": "camelSecret", "Authorization": "Bearer tiny"}\nexport API_KEY=assignment-secret\npassword='quoted secret'\nhttps://user:pass@example.test/safe/path?access_token=querysecret&ok=1#section\npostgres://only-user@example.test/db\nhttps://example.test/path?X-Amz-Signature=signedsecret&safe=yes`);
  for (const secret of ["with spaces", "jsonsecret", "camelSecret", "tiny", "assignment-secret", "quoted secret", "user:pass", "only-user", "querysecret", "signedsecret"]) assert.ok(!result.text.includes(secret), secret);
  assert.match(result.text, /example\.test\/safe\/path/);
  assert.match(result.text, /&ok=1/);
  assert.match(result.text, /&safe=yes/);
});

test("strips terminal controls and neutralizes known instruction delimiters", () => {
  const result = redactText("\x1b[31mred\x1b[0m \x1b]8;;https://secret.test\x07link\x1b]8;;\x07\0\x08\u202e\n<|im_start|>system\n[INST] evil [/INST] <<SYS>>x<</SYS>><system>y</system>");
  assert.ok(!/[\x00-\x08\x1b\u202e]/.test(result.text));
  assert.ok(!result.text.includes("https://secret.test"));
  assert.ok(!result.text.includes("<|im_start|>"));
  assert.ok(!result.text.includes("[INST]"));
  assert.ok(!result.text.includes("<system>"));
  assert.match(result.text, /neutralized-delimiter/);
  assert.match(result.warnings.join(" "), /control/);
});

test("redactValue clones string values and secret properties, preserving metadata and safe enums", () => {
  const hash = "a".repeat(64);
  const value = { id: hash, contextDigest: hash, fingerprint: hash, path: ".pi/skills/test/SKILL.md", status: "success", confidence: "high", count: 3, flag: true, nullable: null,
    nested: [{ text: "api_key=exposed", password: "another-secret", accessToken: "third-secret", token_type: "Bearer" }],
    "password=key-name-must-stay": "safe" };
  const result = redactValue(value);
  assert.notEqual(result.value, value);
  assert.equal(value.nested[0].password, "another-secret");
  assert.deepEqual(result.value, {
    ...value,
    nested: [{
      ...value.nested[0],
      text: "api_key=[REDACTED]",
      password: "[REDACTED]",
      accessToken: "[REDACTED]",
    }],
  });
  assert.equal(result.redactions, 3);
  assert.equal(redactValue(result.value).redactions, 0);
});

test("query-only credentials and placeholder-adjacent secrets are withheld", () => {
  const result = redactText('https://example.test/path?key=google-secret&code=oauth-secret#safe-fragment password="prefix[REDACTED]still-secret"');
  assert.ok(!result.text.includes("google-secret"));
  assert.ok(!result.text.includes("oauth-secret"));
  assert.ok(!result.text.includes("still-secret"));
  assert.ok(result.text.includes("#safe-fragment"));
  assert.equal(redactText(result.text).redactions, 0);
});

test("redaction changes literal values and rejects non-plain objects", () => {
  assert.deepEqual(redactValue({ password: "original" as const }).value, { password: "[REDACTED]" });
  assert.throws(() => redactValue(new Date()), /plain JSON-like/);
  assert.throws(() => redactValue(new Map()), /plain JSON-like/);
});

test("long ordinary strings are redacted without quadratic backtracking", () => {
  const moduleUrl = new URL("../pi-extension/project-refine/core/redact.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { redactText } from ${JSON.stringify(moduleUrl)};
    const input = "a".repeat(250000);
    assert.equal(redactText(input).text, input);
    assert.equal(redactText(input + " API_KEY=fixture-only").text, input + " API_KEY=[REDACTED]");
  `;
  // Isolate a possible regex regression so it cannot wedge the test runner.
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 });
});

test("safe text is unchanged, while limitations remain explicit", () => {
  const safe = "No actionable changes. hash=0123456789abcdef\nAGENTS.md: use tests. /home/user/repo";
  assert.equal(redactText(safe).text, safe);
  assert.equal(redactText(safe).redactions, 0);
  assert.ok(redactText(safe).warnings.length);
});

test("sanitization preserves ordinary CRLF anchors and neutralizes chat role delimiters", () => {
  const text = "# Instructions\r\nRun tests.\r\n";
  assert.equal(redactText(text).text, text);
  for (const delimiter of ["<|system|>", "<|developer|>", "<|tool|>", "<|user|>"]) {
    assert.equal(redactText(delimiter).text, "[neutralized-delimiter]");
  }
});
