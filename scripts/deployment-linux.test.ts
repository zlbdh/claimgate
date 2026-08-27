import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const enabled = process.env.CLAIMGATE_DEPLOYMENT_LINUX === "1";
const image = process.env.CLAIMGATE_DEPLOYMENT_IMAGE ?? "claimgate:deployment-integration";

function dockerShell(script: string) {
  return spawnSync("docker", ["run", "--rm", "--network", "none", "--user", "root",
    "--entrypoint", "sh", image, "-ceu", script], {
    encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
}

describe.runIf(enabled)("Linux deployment runtime contracts", () => {
  it("keeps an application 403 distinct from a gate quota 429 under inherited interception", () => {
    const config = `events {}
http {
  server { listen 18080; proxy_intercept_errors off; location / { return 403; } }
  server { listen 18081; location / { return 403; } }
  server {
    listen 8080;
    proxy_intercept_errors on;
    error_page 403 = @parent_error;
    location = /app { proxy_intercept_errors off; proxy_pass http://127.0.0.1:18080; }
    location = /quota { auth_request /gate; error_page 403 = @limited; proxy_pass http://127.0.0.1:18080; }
    location = /gate { internal; proxy_intercept_errors off; proxy_pass http://127.0.0.1:18081; }
    location @limited { return 429; }
    location @parent_error { return 418; }
  }
}`;
    const script = "printf '%s' \"$CONF\" > /etc/nginx/nginx.conf; nginx; trap 'nginx -s quit 2>/dev/null' EXIT; "
      + "test \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/app)\" = 403; "
      + "test \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/quota)\" = 429";
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "-e", `CONF=${config}`,
      "nginx:1.22.1@sha256:fc5f5fb7574755c306aaf88456ebfbe0b006420a184d52b923d2f0197108f6b7",
      "sh", "-ceu", script], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("extracts under root umask 077 but executes Node and native SQLite as the service identity", () => {
    const result = dockerShell([
      "umask 077", "tar -C /app -czf /tmp/app.tar.gz .", "mkdir /tmp/release", "umask 022",
      "tar -xzf /tmp/app.tar.gz -C /tmp/release --no-same-owner --no-same-permissions",
      "runuser -u node -- node -e \"const D=require('/tmp/release/node_modules/better-sqlite3');const d=new D(':memory:');if(d.prepare('SELECT 1 x').get().x!==1)process.exit(2);d.close()\"",
      "test \"$(stat -c %a /tmp/release/server.js)\" = 644",
    ].join("\n"));
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("creates a group-accessible 0660 socket, rejects a stale nonsocket, and cleans on SIGTERM", () => {
    const key = Buffer.alloc(32, 37).toString("base64");
    const script = [
      "mkdir -p /run/claimgate-ingress-gate /var/lib/claimgate-ingress-gate",
      "chown nobody:www-data /run/claimgate-ingress-gate /var/lib/claimgate-ingress-gate",
      "chmod 750 /run/claimgate-ingress-gate; chmod 700 /var/lib/claimgate-ingress-gate",
      "touch /run/claimgate-ingress-gate/gate.sock", "set +e",
      `CLAIMGATE_INGRESS_KEY=${key} setpriv --reuid=nobody --regid=www-data --clear-groups node scripts/ingress-gate.mjs`,
      "stale=$?", "set -e", "test $stale -ne 0", "test ! -e /run/claimgate-ingress-gate/gate.sock",
      "rm -f /var/lib/claimgate-ingress-gate/*",
      `CLAIMGATE_INGRESS_KEY=${key} setpriv --reuid=nobody --regid=www-data --clear-groups node scripts/ingress-gate.mjs &`,
      "pid=$!", "i=0; while [ ! -S /run/claimgate-ingress-gate/gate.sock ]; do i=$((i+1)); test $i -lt 50; sleep .05; done",
      "test \"$(stat -c %a /run/claimgate-ingress-gate/gate.sock)\" = 660",
      "test \"$(stat -c %G /run/claimgate-ingress-gate/gate.sock)\" = www-data",
      "setpriv --reuid=www-data --regid=www-data --clear-groups node -e \"const h=require('http');const r=h.request({socketPath:'/run/claimgate-ingress-gate/gate.sock',path:'/check',headers:{Host:'claimgate-ingress-gate','X-ClaimGate-Source':'192.0.2.1','X-ClaimGate-Origin-Policy':'1','X-ClaimGate-Fetch-Policy':'1'}},x=>{console.log(x.statusCode);process.exit(x.statusCode===204?0:2)});r.end()\"",
      "kill -TERM $pid", "wait $pid", "test ! -e /run/claimgate-ingress-gate/gate.sock",
    ].join("\n");
    const result = dockerShell(script);
    expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
      status: 0, stderr: "ClaimGate ingress gate failed.\n", stdout: "204\n",
    });
  });
});
