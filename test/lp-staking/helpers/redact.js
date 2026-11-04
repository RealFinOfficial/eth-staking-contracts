const fs = require("fs");
const path = require("path");

/**
 * Keeps RPC credentials out of everything the fork suites print or write.
 *
 * The suites resolve an upstream endpoint from `MAINNET_RPC_URL` / `SEPOLIA_RPC_URL` /
 * `INFURA_API_KEY`, and for Infura (or Alchemy, QuickNode, …) that URL carries the company's
 * project key in its PATH: `https://sepolia.infura.io/v3/<key>`. Every console line, every
 * error message and every file in the suites' scratch directory goes through here first, so the
 * key never lands in a CI log, a terminal scrollback or a temp file someone attaches to a ticket.
 *
 * What counts as secret, conservatively: a path segment of 16+ characters drawn from
 * `[A-Za-z0-9_-]` (API keys and project ids; `v3`, `eth`, `rpc` and host names stay readable),
 * any query string, and any `user:password@` part. Public endpoints with no key come out
 * unchanged, so the notes still say WHICH endpoint served the fork.
 */

const SECRET_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;
const URL_SHAPE = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi;
const MARK = "<redacted>";

/** Rewrites one URL, replacing each secret part with `mask(part)`. */
function rewrite(url, mask) {
  const text = String(url);
  const match = URL_SHAPE.exec(text);
  if (!match) return text;
  const [, scheme, authority, pathPart, query = "", fragment = ""] = match;
  const at = authority.lastIndexOf("@");
  const host = at === -1 ? authority : `${mask(authority.slice(0, at))}@${authority.slice(at + 1)}`;
  const segments = pathPart.split("/").map((segment) => (SECRET_SEGMENT.test(segment) ? mask(segment) : segment));
  return (
    scheme +
    host +
    segments.join("/") +
    (query ? `?${mask(query.slice(1))}` : "") +
    (fragment ? `#${mask(fragment.slice(1))}` : "")
  );
}

/**
 * Applies `fn` to every URL inside free text. Trailing punctuation (`from <url>: reason`,
 * `<url>.`) belongs to the sentence, not to the URL, and would otherwise hide a key segment.
 */
function eachUrl(text, fn) {
  return String(text).replace(URL_IN_TEXT, (found) => {
    const tail = /[.,:;!?]+$/.exec(found);
    const url = tail ? found.slice(0, -tail[0].length) : found;
    return fn(url) + (tail ? tail[0] : "");
  });
}

/** `https://sepolia.infura.io/v3/<key>` -> `https://sepolia.infura.io/v3/<redacted>`. */
function redactRpc(url) {
  return rewrite(url, () => MARK);
}

/** Every URL inside a free-form string (an error message, a log line), redacted. */
function redactRpcText(text) {
  return eachUrl(text, redactRpc);
}

/**
 * The same redaction with the byte length preserved (`<redacted>` padded with `*`, or `*` alone
 * for a short secret), so a file can be rewritten IN PLACE while a `hardhat node` child is still
 * appending to it: a positional write of the same length never truncates and never races the
 * child's O_APPEND writes.
 */
function maskSameLength(text) {
  const pad = (secret) =>
    secret.length >= MARK.length ? MARK + "*".repeat(secret.length - MARK.length) : "*".repeat(secret.length);
  return eachUrl(text, (url) => rewrite(url, pad));
}

/** Masks every credential in one file, in place, without changing its length. */
function scrubFile(file) {
  const before = fs.readFileSync(file);
  const text = before.toString("latin1");
  const after = maskSameLength(text);
  if (after === text) return false;
  const buffer = Buffer.from(after, "latin1");
  const fd = fs.openSync(file, "r+");
  try {
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Masks every credential in every regular file under `dir` (the suites' scratch directory). */
function scrubDirectory(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let scrubbed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scrubbed += scrubDirectory(full);
    else if (entry.isFile() && scrubFile(full)) scrubbed++;
  }
  return scrubbed;
}

module.exports = { redactRpc, redactRpcText, maskSameLength, scrubFile, scrubDirectory };
