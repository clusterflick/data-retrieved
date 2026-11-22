// One-off probe: request a URL several different ways and report what each
// gets back, to tell a refusal of the address apart from a refusal of the
// request. Run from experiment.yml on a branch; nothing here feeds a release.
//
// Prints status, the headers that say who answered, the page title and how
// many of SELECTOR the body holds. Never prints the runner's IP.

const { execFileSync } = require("node:child_process");
const cheerio = require("cheerio");

const URL_TO_PROBE = process.env.PROBE_URL;
const SELECTOR = process.env.PROBE_SELECTOR;
if (!URL_TO_PROBE || !SELECTOR) {
  throw new Error("PROBE_URL and PROBE_SELECTOR must both be set");
}

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": CHROME_UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
const HEADERS_OF_INTEREST = [
  "server",
  "content-type",
  "cf-mitigated",
  "cf-cache-status",
  "x-scout-cache",
  "sg-captcha",
  "cdn-challenge",
  "x-sucuri-id",
  "x-sucuri-block",
  "x-nitro-cache",
  "x-litespeed-cache",
];

function report(label, { status, headers, body, error }) {
  console.log(`\n=== ${label}`);
  if (error) {
    console.log(`  error: ${error}`);
    return;
  }
  console.log(`  status: ${status}`);
  for (const name of HEADERS_OF_INTEREST) {
    const value = headers[name];
    if (value) console.log(`  ${name}: ${value}`);
  }
  const $ = cheerio.load(body || "");
  console.log(`  title: ${$("title").first().text().trim().slice(0, 120)}`);
  console.log(`  ${SELECTOR}: ${$(SELECTOR).length}`);
  console.log(`  body length: ${(body || "").length}`);
  if ($(SELECTOR).length === 0) {
    const text = $("body").text().replace(/\s+/g, " ").trim();
    console.log(`  body text: ${text.slice(0, 600)}`);
  }
}

async function viaFetch(label, headers) {
  try {
    const response = await fetch(URL_TO_PROBE, { headers });
    const body = await response.text();
    report(label, {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    });
  } catch (error) {
    report(label, { error: error.message });
  }
}

function viaCurl(label, args) {
  try {
    const out = execFileSync(
      "curl",
      [
        "-sS",
        "--compressed",
        "-D",
        "-",
        "-w",
        "\n__STATUS__%{http_code}",
        ...args,
        URL_TO_PROBE,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const status = Number(out.slice(out.lastIndexOf("__STATUS__") + 10));
    const withoutStatus = out.slice(0, out.lastIndexOf("\n__STATUS__"));
    // Headers of the last response (after any proxy CONNECT block).
    const blocks = withoutStatus.split(/\r?\n\r?\n/);
    const headerBlockIndex = blocks.findLastIndex((b) => /^HTTP\//.test(b));
    const headers = {};
    for (const line of blocks[headerBlockIndex].split(/\r?\n/).slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    const body = blocks.slice(headerBlockIndex + 1).join("\n\n");
    report(label, { status, headers, body });
  } catch (error) {
    report(label, { error: error.message });
  }
}

async function viaBrowser(label, withSession) {
  try {
    let result;
    await withSession(async (getPage) => {
      result = await getPage(
        URL_TO_PROBE,
        `probe-${label.replace(/[^a-z0-9]+/gi, "-")}`,
        async (page, response) => {
          // Give a challenge a chance to clear before reading the page.
          await page
            .waitForSelector(SELECTOR, { state: "attached", timeout: 30_000 })
            .catch(() => {});
          return {
            status: response ? response.status() : 0,
            headers: response ? response.headers() : {},
            body: await page.content(),
          };
        },
        { disableCache: true },
      );
    });
    report(label, result);
  } catch (error) {
    report(label, { error: error.message });
  }
}

(async () => {
  await viaFetch("fetch, default headers (what the retrieve sends)", {});
  await viaFetch("fetch, Chrome User-Agent only", { "User-Agent": CHROME_UA });
  await viaFetch("fetch, full browser headers", BROWSER_HEADERS);

  viaCurl("curl, User-Agent: node", ["-A", "node"]);
  viaCurl("curl, Chrome User-Agent", ["-A", CHROME_UA]);

  const { withPlaywrightSession } = require("scripts/common/get-page-with-playwright");
  await viaBrowser("Playwright Chromium + stealth", withPlaywrightSession);

  const { withCamoufoxSession } = require("scripts/common/get-page-with-camoufox");
  await viaBrowser("Camoufox", withCamoufoxSession);
})();
