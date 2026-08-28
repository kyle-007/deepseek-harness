# Agent Note: Unconverted fetch bodies sanitize like converted ones, and charsets decode statelessly

Status: implemented

English | [中文](2026-08-28-web-fetch-fallback-sanitization-and-stateless-charsets.zh.md)

## Problem

Two model-visible paths through `web_fetch` treated markup and bytes the fetch path could not safely handle as if they were ordinary content.

`renderBody` in [`dsh-tool-web`](../../../../packages/web/tool-web/src/fetch.ts) reaches turndown only when the depth preflight passes and the conversion returns. `turndown.remove(['script', 'style', 'noscript'])` is a turndown configuration, so it runs on that path alone. The two fallbacks — HTML nested past `MAX_CONVERSION_DEPTH`, and a conversion that throws — returned the source string untouched. Sanitization was therefore absent exactly where the input is most likely hostile: both fallbacks are reached by adversarial markup and by little else, since real pages nest a few dozen levels and convert without throwing. A page whose script body needed to reach the model verbatim only had to nest 513 elements. That text then became tool-result content and was persisted to the session log.

`decoderForCharset` in [`dsh-web-fetch-http`](../../../../packages/web/web-fetch-http/src/policy.ts) passed the server-declared charset label straight to `TextDecoder` and accepted whatever the platform recognized. Its rejection arm exists to avoid mojibake, not to bound what a charset may do: a label the platform knows was always honored. `iso-2022-jp` switches character sets through in-band escape sequences, so the same response bytes decode to different text depending on what preceded them, and `x-user-defined` is not a text decoding at all but a raw byte passthrough into a private-use range. Both let the response's own `Content-Type` header change what its bytes mean.

Both gaps were found by threat-modeling the `packages/web/*` seam rather than by a failure in production.

## Decision

Both unconverted paths run `stripRawTextElements` before returning. It removes `RAW_TEXT_ELEMENTS` — the same `script`, `style`, `noscript` set the depth scanner already owns — and their contents, so a body that skips conversion carries no markup a converted body would have lost. Scanning reuses the lexical machinery beside it rather than introducing a parser or a sanitizer dependency: `findRawTextEnd` locates the end tag without interpreting markup-like body text, and a quoted `>` does not end an open tag. An element with no end tag drops everything to the end of the input, because a `<script>` with no end tag has no content that is not script. A stray end tag matches no open tag and stays as text.

`decoderForCharset` builds the decoder, then rejects it when the canonical `TextDecoder.encoding` names a stateful encoding. The check reads the canonical name rather than the declared label, so every WHATWG alias of a rejected encoding is covered without enumerating aliases. `STATEFUL_ENCODINGS` holds exactly `iso-2022-jp` and `x-user-defined`: the rest of that class — `hz-gb-2312`, `iso-2022-kr`, `iso-2022-cn`, `utf-7` — are not `TextDecoder` labels at all and already fail construction. Every stateless encoding a real page declares still decodes, including `shift_jis`, `euc-jp`, `gbk`, `gb18030`, `big5`, and `euc-kr`.

Neither value is a `Config` field. A deployment that could widen the accepted charsets or keep script bodies in a fallback would be choosing what untrusted input may do, which is the security invariant these constants state; `MAX_CONVERSION_DEPTH` beside them is fixed for the same reason.

## Alternatives considered

- **A full HTML sanitizer (`sanitize-html`, DOMPurify) on the fallback** — buys an attribute and scheme allowlist this path does not need. The fallback output is markdown-adjacent text for a model, not a document a browser executes, so the property worth restoring is parity with the converted path. A sanitizer would also parse markup that reached the fallback *because* parsing it is expensive, reintroducing the synchronous cost the depth guard exists to avoid.
- **Erroring instead of falling back** — turns a degraded page into no page. The existing decision that a bounded degraded body beats an error for content the provider already decoded still holds; only its sanitization was inconsistent.
- **Running the fallback text through turndown with conversion disabled** — turndown's `remove` list is reachable only through a real DOM walk, which is the work the fallback exists to skip.
- **An allowlist of accepted charsets rather than a stateful-encoding rejection** — the practical web needs roughly a dozen canonical encodings plus their aliases, and enumerating them makes the common case a maintenance surface while the excluded set is two names. Rejecting on a decoding property states the rule the check actually enforces.
- **Defaulting a rejected charset to UTF-8 instead of throwing** — silently mangles a page that honestly declared an encoding the harness declines to trust. `WEB_UNSUPPORTED_CONTENT_TYPE` already carries this meaning for undecodable bodies.

## Consequences

- A fetched page can no longer deliver `script`, `style`, or `noscript` content to the model or the session log by choosing markup that defeats conversion. Benign markup in the fallback is unchanged, so the existing raw-passthrough assertions still hold.
- `stripRawTextElements` shares `RAW_TEXT_ELEMENTS`, `isTagBoundary`, and `findRawTextEnd` with `exceedsConversionDepth`. A change to how the depth scanner recognizes those elements changes stripping too; that coupling is intended, because the two must agree on what a raw-text element is.
- A response declaring `iso-2022-jp` or `x-user-defined` now fails with `WEB_UNSUPPORTED_CONTENT_TYPE` rather than returning decoded text. This is a behavior change for any deployment fetching such a page; no shipped bundle mounts the fetch provider, so nothing shipped is affected today.
- Neither change touches the deferred SSRF work recorded in [the web capability seam Agent Note](../architecture/2026-06-24-web-capability-seam.md). `web_fetch` remains an SSRF primitive and the deferral there is still the governing record.

## Testing

`tool-web.spec.ts` covers both fallback branches and the ways markup could evade stripping: a quoted `>` in the open tag, an unterminated element, an end tag spelled inside a script body, a stray end tag, a name that merely starts with a raw-text name, and an end tag carrying trailing space. `fetch-http.spec.ts` covers the rejected encodings through several aliases and asserts the stateless encodings real pages declare still resolve. Each new test fails against the previous behavior.
