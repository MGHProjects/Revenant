import { guard } from "../src/core/guard.ts";

const cases = [
  ["http://127.0.0.1/", "block", "loopback IPv4"],
  ["http://10.0.0.1/", "block", "private 10/8"],
  ["http://172.16.0.1/", "block", "private 172.16/12"],
  ["http://192.168.1.1/", "block", "private 192.168/16"],
  ["http://169.254.1.1/", "block", "link-local IPv4"],
  ["http://100.64.0.1/", "block", "CGNAT"],
  ["http://0.1.2.3/", "block", "0/8"],
  ["http://[::1]/", "block", "loopback IPv6"],
  ["http://[fe80::1]/", "block", "link-local IPv6"],
  ["http://[fc00::1]/", "block", "ULA IPv6"],
  ["http://[::ffff:c0a8:101]/", "block", "IPv4-mapped private"],
  ["http://[::ffff:7f00:1]/", "block", "IPv4-mapped loopback"],
  ["ftp://example.com/", "block", "wrong scheme"],
  ["http://user:pass@example.com/", "block", "credentials"],
  ["http://localhost/", "block", "localhost"],
  ["http://foo.local/", "block", ".local"],
  ["http://foo.internal/", "block", ".internal"],
  ["http://foo.localhost/", "block", ".localhost"],
  ["https://example.com/", "allow", "public domain"],
  ["http://1.2.3.4/", "allow", "public IPv4"],
  ["http://[2001:db8::1]/", "allow", "documentation IPv6"],
];

let pass = 0, fail = 0;
for (const [url, expect, label] of cases) {
  const result = guard(url);
  const blocked = !result.ok;
  const shouldBlock = expect === "block";
  if (blocked !== shouldBlock) {
    console.error("FAIL " + url + " (" + label + ") -> " + JSON.stringify(result));
    fail++;
  } else {
    console.log("OK   " + url.padEnd(45) + (blocked ? "blocked: " + result.reason : "allowed"));
    pass++;
  }
}
console.log(pass + " passed, " + fail + " failed");
