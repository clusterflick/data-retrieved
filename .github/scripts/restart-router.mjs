// Restarts the ZTE MC889 the runners share, then waits for the internet to
// come back on a new public IP.
//
// The calls are the ones the router's own web page makes (service.js,
// util.js and login.js in its firmware):
//
// - LOGIN sends password = SHA256(SHA256(password) + LD), with LD fetched just
//   before it. Every SHA256 here is upper-case hex.
// - Every other POST carries AD = SHA256(SHA256(wa_inner_version +
//   cr_version) + RD). The router replaces RD after each POST, so it is
//   fetched afresh for every one.
//
// Usage: ROUTER_USERNAME='...' ROUTER_PASSWORD='...' node restart-router.mjs
import { createHash } from "node:crypto";

const ROUTER = "http://192.168.254.1";
const PUBLIC_IP_URL = "https://api.ipify.org";
const POLL_INTERVAL_MS = 10_000;
const WAIT_LIMIT_MS = 15 * 60_000;

const sha = (s) => createHash("sha256").update(s).digest("hex").toUpperCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The page starts with an empty stok cookie and the router replaces it on login.
const cookies = new Map([["stok", '""']]);

const request = async (path, init = {}) => {
  const response = await fetch(`${ROUTER}${path}`, {
    ...init,
    headers: {
      Referer: `${ROUTER}/`,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Router answered ${path} with ${response.status}`);
  }
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return JSON.parse(await response.text());
};

const get = (cmd) => {
  const query = new URLSearchParams({ isTest: "false", cmd, _: Date.now() });
  return request(`/goform/goform_get_cmd_process?${query}`);
};

const post = (fields) =>
  request("/goform/goform_set_cmd_process", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: new URLSearchParams({ isTest: "false", ...fields }),
  });

const getPublicIp = async () => {
  const response = await fetch(PUBLIC_IP_URL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${PUBLIC_IP_URL} answered ${response.status}`);
  }
  return (await response.text()).trim();
};

const { ROUTER_USERNAME: username, ROUTER_PASSWORD: plain } = process.env;
if (!username || !plain) {
  throw new Error("ROUTER_USERNAME and ROUTER_PASSWORD must both be set");
}

// The repository is public, and so are its workflow logs: the addresses are
// compared here and never printed.
const before = await getPublicIp();
console.log("Recorded the current public IP");

const { LD: ld } = await get("LD");
const login = await post({
  goformId: "LOGIN",
  username,
  password: sha(sha(plain) + ld.toUpperCase()),
});
if (login.result !== "0") {
  throw new Error(`Login refused: ${JSON.stringify(login)}`);
}
const { loginfo } = await get("loginfo");
if (loginfo !== "ok") {
  throw new Error(`Logged in but loginfo is ${JSON.stringify(loginfo)}`);
}
console.log("Logged in to the router");

const { wa_inner_version: rd0 } = await get("wa_inner_version");
const { cr_version: rd1 } = await get("cr_version");
const { RD: rd } = await get("RD");

// The router may go down before it answers, so a dropped request here is the
// restart taking effect. Only an answer saying it refused is a failure.
let restart;
try {
  restart = await post({
    goformId: "REBOOT_DEVICE",
    AD: sha(sha(rd0 + rd1) + rd),
  });
} catch (error) {
  console.log(`Restart request got no answer (${error.message}), as expected`);
}
if (restart) {
  console.log(`Restart requested: ${JSON.stringify(restart)}`);
  if (restart.result === "failure") {
    throw new Error("The router refused the restart");
  }
}

// Done once the internet answers from a different address. Until the router
// actually goes down the old IP keeps answering, so this also covers the gap
// before it does.
const deadline = Date.now() + WAIT_LIMIT_MS;
while (Date.now() < deadline) {
  await sleep(POLL_INTERVAL_MS);
  try {
    const after = await getPublicIp();
    if (after !== before) {
      console.log("Back online on a new public IP");
      process.exit(0);
    }
    console.log("Still on the old public IP");
  } catch (error) {
    console.log(`No internet yet (${error.message})`);
  }
}
throw new Error(
  `The public IP was unchanged, or the internet was still unreachable, ` +
    `${WAIT_LIMIT_MS / 60_000} minutes after the restart`,
);
