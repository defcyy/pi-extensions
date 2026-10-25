import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupportedContentType,
  htmlToText,
  normalizeFetchedContent,
  parseDuckDuckGoResults,
  plainTextFromHtml,
} from "../pi-extension/web-search/web.ts";

test("HTML retains useful header/aside content, links, code whitespace and tables", () => {
  const { title, content } = htmlToText(`<head><title>Docs &amp; API</title></head>
    <header><h1>API reference</h1></header><aside>Important compatibility note</aside>
    <p>Read <a href='/docs?q=one&amp;lang=en'>the docs</a> and <code>a &lt; b</code>.</p>
    <pre><code>if (ready) {\n  run();\n}</code></pre>
    <table><tr><th>Name</th><th>Value</th></tr><tr><td>limit</td><td>42</td></tr></table>
    <script>secretScript()</script><style>.hidden{}</style>`);
  assert.equal(title, "Docs & API");
  assert.match(content, /API reference/);
  assert.match(content, /Important compatibility note/);
  assert.match(content, /\[the docs\]\(<\/docs\?q=one&lang=en>\)/);
  assert.match(content, /` a < b `/);
  assert.match(content, /```\nif \(ready\) {\n  run\(\);\n}\n```/);
  assert.match(content, /\| Name \| Value \|\n\| --- \| --- \|\n\| limit \| 42 \|/);
  assert.doesNotMatch(content, /secretScript|hidden/);
});

test("entity decoding is single-pass and handles invalid numeric scalars", () => {
  assert.equal(plainTextFromHtml("&#x1F600; &#X41; &#1114112; &#xD800; &#0;"), "😀 A � � �");
  assert.equal(plainTextFromHtml("&amp;lt; &lt; &copy;"), "&lt; < ©");
  assert.doesNotThrow(() => htmlToText("&#99999999999999999999999999;"));
});

test("DDG decodes attributes, supports unquoted attributes, rejects non-HTTP and deduplicates", () => {
  const results = parseDuckDuckGoResults(`
    <a class=result__a href='javascript:alert(1)'>bad</a>
    <a class='result__a' href='//duckduckgo.com/l/?x=1&amp;uddg=ftp%3A%2F%2Fexample.test'>bad redirect</a>
    <a class='result__a' href='https://example.test/?a=1&amp;b=2'>First</a>
    <a class='result__snippet'>Useful &amp; readable</a>
    <a class=result__a href='https://example.test/?a=1&#38;b=2'>Duplicate</a>
    <a data-class=result__a href='https://wrong.test/'>Not a result</a>
  `);
  assert.deepEqual(results, [{ title: "First", url: "https://example.test/?a=1&b=2", snippet: "Useful & readable" }]);
});

test("unsupported MIME types can be rejected without reading a body", () => {
  const response = new Response(new ReadableStream({ start() {} }), {
    headers: { "content-type": "application/pdf" },
  });
  assert.throws(() => assertSupportedContentType(response.headers.get("content-type")), /Unsupported content type/);
  assert.equal(response.bodyUsed, false);
  for (const mime of ["image/png", "audio/mpeg", "application/zip", "application/octet-stream"]) {
    assert.throws(() => normalizeFetchedContent(mime, "binary"), /Unsupported content type/);
  }
  for (const mime of [null, "text/plain; charset=utf-8", "application/problem+json", "application/xml"]) {
    assert.doesNotThrow(() => assertSupportedContentType(mime));
  }
  assert.equal(normalizeFetchedContent("Application/Problem+JSON; charset=utf-8", '{"ok":true}').content, '{\n  "ok": true\n}');
  assert.match(normalizeFetchedContent("application/xhtml+xml", "<p>Readable</p>").content, /Readable/);
});

test("HTML links decode quoted attributes and do not emit executable destinations", () => {
  const { content } = htmlToText(`<a href="https://example.test/?x=&quot;yes&quot;&amp;y=2">Visit</a>
    <a href="java&#115;cript:alert(1)">Keep label</a>`);
  assert.match(content, /https:\/\/example.test\/\?x="yes"&y=2/);
  assert.match(content, /Keep label/);
  assert.doesNotMatch(content, /javascript|alert/);
});
