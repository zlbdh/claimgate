import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("isolated deployment assets", () => {
  it("builds a Linux standalone image with the native SQLite module as a non-root user", async () => {
    const dockerfile = await read("deploy/Dockerfile");
    const archiveValidator = await read("scripts/validate-release-archive.py");

    expect(dockerfile).toContain(
      "ARG NODE_IMAGE=node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e",
    );
    expect(dockerfile.match(/FROM \$\{NODE_IMAGE\}/g)).toHaveLength(3);
    expect(dockerfile).toContain("npm ci --no-audit --no-fund");
    expect(dockerfile).toContain("npm run build");
    expect(dockerfile).toContain("/app/.next/standalone");
    expect(dockerfile).toContain("/app/.next/static");
    expect(dockerfile).toContain(
      "COPY --from=builder --chown=node:node /app/scripts/healthcheck.mjs ./scripts/healthcheck.mjs",
    );
    for (const helper of ["ingress-gate-store.mjs", "ingress-gate-http.mjs", "ingress-gate.mjs"]) {
      expect(dockerfile).toContain(`/app/scripts/${helper}`);
    }
    expect(dockerfile).toContain(
      "/app/scripts/validate-release-archive.py ./scripts/validate-release-archive.py",
    );
    expect(dockerfile).toMatch(/require\(["']better-sqlite3["']\)/);
    expect(dockerfile).toContain("new Database(':memory:')");
    expect(dockerfile).toContain("prepare('SELECT 1 AS value').get()");
    expect(dockerfile).toContain("database.close()");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile.indexOf("USER node")).toBeLessThan(
      dockerfile.indexOf("require('better-sqlite3')"),
    );
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
    expect(dockerfile).toContain(
      'CMD ["node", "scripts/healthcheck.mjs", "http://127.0.0.1:3000"]',
    );
    expect(dockerfile).not.toContain("fetch('http://127.0.0.1:3000/api/health')");
    expect(dockerfile).not.toMatch(/COPY\s+.*\.env/i);
    expect(archiveValidator).toContain("sys.version_info[:2] != (3, 11)");
  });

  it("keeps the optional Compose runtime loopback-only, bounded, and isolated", async () => {
    const compose = await read("deploy/docker-compose.example.yml");

    expect(compose).toContain("platform: linux/amd64");
    expect(compose).toContain('127.0.0.1:18121:3000');
    expect(compose).toContain("/var/lib/claimgate");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("mem_limit: 384m");
    expect(compose).toMatch(/internal:\s*true/);
    expect(compose).not.toMatch(/network_mode:\s*host/);
    expect(compose).not.toMatch(/(?:^|["'])0\.0\.0\.0:18121/m);
  });

  it("runs the systemd fallback under a dedicated identity and write boundary", async () => {
    const unit = await read("deploy/claimgate.service.example");
    const gateUnit = await read("deploy/claimgate-ingress-gate.service.example");
    const gateCli = await read("scripts/ingress-gate.mjs");

    for (const contract of [
      "User=claimgate",
      "Group=claimgate",
      "WorkingDirectory=/opt/claimgate/current",
      "EnvironmentFile=/etc/claimgate/claimgate.env",
      "Environment=HOSTNAME=127.0.0.1",
      "Environment=PORT=18121",
      "Environment=NODE_OPTIONS=--max-old-space-size=256",
      "ExecStart=/opt/claimgate/runtime/current/bin/node /opt/claimgate/current/server.js",
      "ProtectSystem=strict",
      "NoNewPrivileges=true",
      "ReadWritePaths=/var/lib/claimgate",
      "ReadWritePaths=/opt/claimgate/current/.next/cache",
      "MemoryMax=384M",
    ]) expect(unit).toContain(contract);

    for (const contract of [
      "User=claimgate-gate",
      "Group=www-data",
      "StateDirectory=claimgate-ingress-gate",
      "RuntimeDirectory=claimgate-ingress-gate",
      "EnvironmentFile=/etc/claimgate/ingress-gate.env",
      "RestrictAddressFamilies=AF_UNIX",
      "PrivateNetwork=true",
      "MemoryMax=96M",
      "ExecStart=/opt/claimgate/runtime/current/bin/node /opt/claimgate/current/scripts/ingress-gate.mjs",
    ]) expect(gateUnit).toContain(contract);
    expect(gateCli).toContain(
      'INGRESS_GATE_DATABASE_PATH = "/var/lib/claimgate-ingress-gate/ingress-gate.db"',
    );
    expect(gateCli).not.toContain("CLAIMGATE_INGRESS_DATABASE_PATH");
  });

  it("adds a dedicated 8443 TLS vhost without HSTS or an existing-service target", async () => {
    const nginx = await read("deploy/nginx-claimgate.conf.example");
    const bootstrap = await read("deploy/nginx-claimgate-acme-bootstrap.conf.example");

    expect(bootstrap).toContain("listen 80;");
    expect(bootstrap).toContain("root /var/www/claimgate-acme;");
    expect(bootstrap).toContain("server_name ds.zlbdh.top;");
    expect(bootstrap).not.toMatch(/8443|ssl_certificate|proxy_pass/);

    expect(nginx).toMatch(/listen\s+80;/);
    expect(nginx).toContain("/.well-known/acme-challenge/");
    expect(nginx).toContain("root /var/www/claimgate-acme;");
    expect(nginx).toContain("return 308 https://ds.zlbdh.top:8443$request_uri;");
    expect(nginx).toMatch(/listen\s+8443\s+ssl\s+http2;/);
    expect(nginx).toContain("server_name ds.zlbdh.top;");
    expect(nginx).toContain("client_max_body_size 16k;");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:18121;");
    expect(nginx).toContain("proxy_set_header Host ds.zlbdh.top:8443;");
    expect(nginx).toContain("proxy_set_header X-Forwarded-Host ds.zlbdh.top:8443;");
    expect(nginx).toContain("proxy_set_header X-Forwarded-Proto https;");
    expect(nginx).toContain("proxy_set_header X-Forwarded-For $realip_remote_addr;");
    expect(nginx).not.toContain("$proxy_add_x_forwarded_for");
    expect(nginx).toContain("proxy_cache off;");
    expect(nginx).toMatch(/location = \/api\/demo\/start\s*\{/);
    expect(nginx).toContain("if ($request_method != POST) {");
    expect(nginx).toContain("return 405;");
    expect(nginx).toContain("auth_request /_claimgate_demo_start_gate;");
    expect(nginx).toContain(
      "auth_request_set $claimgate_gate_retry_after $upstream_http_retry_after;",
    );
    expect(nginx).toContain("error_page 403 = @claimgate_demo_start_limited;");
    expect(nginx).toContain("error_page 401 = @claimgate_demo_start_forbidden;");
    expect(nginx).toContain("location @claimgate_demo_start_forbidden {");
    expect(nginx).toContain("return 403;");
    expect(nginx).toContain("location = /_claimgate_demo_start_gate {");
    expect(nginx).toContain("internal;");
    expect(nginx).toContain("proxy_pass_request_body off;");
    expect(nginx).toContain("proxy_pass_request_headers off;");
    expect(nginx).toContain('proxy_set_header Content-Length "";');
    expect(nginx).toContain("proxy_set_header X-ClaimGate-Source $realip_remote_addr;");
    expect(nginx).toContain("proxy_intercept_errors off;");
    expect(nginx).toContain("map $http_origin $claimgate_origin_policy {");
    expect(nginx).toContain("~^https://ds\\.zlbdh\\.top:8443$ 1;");
    expect(nginx).toContain("map $http_sec_fetch_site $claimgate_fetch_policy {");
    expect(nginx).toContain("~^same-origin$ 1;");
    expect(nginx).toContain("proxy_set_header X-ClaimGate-Origin-Policy $claimgate_origin_policy;");
    expect(nginx).toContain("proxy_set_header X-ClaimGate-Fetch-Policy $claimgate_fetch_policy;");
    expect(nginx).not.toContain("proxy_set_header X-ClaimGate-Origin $http_origin;");
    expect(nginx).not.toContain("proxy_set_header X-ClaimGate-Fetch-Site $http_sec_fetch_site;");
    const gateLocation = nginx.match(/location = \/_claimgate_demo_start_gate \{([\s\S]*?)\n    \}/)?.[1];
    expect(gateLocation?.match(/^\s*proxy_set_header\s+/gm)).toHaveLength(6);
    expect(gateLocation).not.toMatch(/Cookie|Authorization|X-Forwarded/i);
    expect(nginx).toContain(
      "proxy_pass http://unix:/run/claimgate-ingress-gate/gate.sock:/check;",
    );
    expect(nginx).toContain("return 429;");
    expect(nginx).toContain("add_header Retry-After $claimgate_gate_retry_after always;");
    expect(nginx).toContain("proxy_connect_timeout 250ms;");
    expect(nginx).toContain("proxy_send_timeout 1s;");
    expect(nginx).toContain("proxy_read_timeout 1s;");
    expect(nginx).not.toContain("limit_req");
    expect(nginx).toContain("REPLACE_WITH_CERTIFICATE_NAME");
    expect(nginx).not.toMatch(/strict-transport-security|\bhsts\b/i);
    expect(nginx).not.toMatch(/listen\s+\[::\]:8443/);
    expect(nginx).not.toContain("$http_host");
    expect(nginx).not.toContain("https://$host:8443");
    expect(nginx.match(/^\s*proxy_pass\s+/gm)).toHaveLength(3);
    expect(nginx.match(/server_name/g)).toHaveLength(2);
  });

  it("excludes local secrets and mutable state from the image context", async () => {
    const dockerignore = await read(".dockerignore");
    const gitignore = await read(".gitignore");

    for (const contract of [
      ".env*", ".git", ".next", "node_modules", "*.db", "*.db-*", "*.sqlite*", "*.pem", "*.key",
      "release-out", "*.tar.gz", "SHA256SUMS.txt",
    ]) {
      expect(dockerignore).toContain(contract);
    }
    expect(dockerignore).not.toContain("!.env");
    expect(gitignore).toContain("release-out/");
  });

  it("documents additive rollout, scoped rollback, and three-layer verification", async () => {
    const deployment = await read("docs/submission/deployment.md");
    const prepareRelease = await read("scripts/prepare-release-artifacts.sh");
    const verifyRelease = await read("scripts/verify-release-artifacts.sh");
    const deployController = await read("scripts/deploy-release-over-ssh.sh");
    const releaseContract = `${deployment}\n${prepareRelease}\n${verifyRelease}\n${deployController}`;

    for (const contract of [
      "Additive deployment",
      "Scoped rollback",
      "Server loopback",
      "Public HTTPS",
      "In-app browser",
      "127.0.0.1:18121",
      "https://ds.zlbdh.top:8443",
      "/opt/claimgate",
      "/var/lib/claimgate",
      "/etc/claimgate",
      "Do not recursively delete",
      "unchanged",
      "systemctl enable --now claimgate.service",
      "systemctl is-enabled claimgate.service",
      "Version rollback",
      "Complete removal",
      "certbot certonly --webroot",
      "node scripts/healthcheck.mjs",
      '"$sha_command" -c SHA256SUMS.txt',
      "rolling ten-minute window",
      "HMAC-SHA-256 pseudonym",
      "auth_request",
      "claimgate-ingress-gate.service",
      "never persists the raw source IP",
      "root:root 0600",
      "root:root 0700",
      "stat -c '%U:%G %a'",
      "/usr/bin/python3 ./validate-release-archive.py",
      "MemoryMax=192M",
      "CPUQuota=50%",
      "TasksMax=8",
      "PrivateNetwork=yes",
      "Node runtime archive risk",
    ]) expect(releaseContract).toContain(contract);

    for (const inventoryFact of [
      "The production host is Debian 12",
      "has no system Node executable",
      "does not use Docker",
      "An existing application already uses public port 8443",
    ]) expect(deployment).not.toContain(inventoryFact);

    expect(releaseContract).toContain(
      "node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e",
    );
    expect(releaseContract).toMatch(/tar -C \/app .+claimgate-app-linux-amd64\.tar\.gz/);
    expect(releaseContract).not.toMatch(/tar -C \/usr\/local/);
    expect(releaseContract).not.toContain("claimgate-node-linux-amd64.tar.gz");
    expect(releaseContract).toContain("node-v22.20.0-linux-x64.tar.gz");
    expect(releaseContract).toContain(
      "eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29",
    );
    expect(releaseContract).toContain("https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.gz");
    expect(releaseContract).toContain("--strip-components=1");
    expect(releaseContract).toContain("process.platform");
    expect(releaseContract).toContain("process.arch");
    expect(prepareRelease).toContain('manifest_tmp="$output_dir/.SHA256SUMS.txt.$$"');
    expect(prepareRelease).toContain('rm -f "$image_id_file" "$context_tar" "$lock_dir/owner"');
    expect(prepareRelease).toContain('archive --format=tar --output="$context_tar" "$revision"');
    expect(prepareRelease).toContain(' - < "$context_tar"');
    expect(prepareRelease).toContain("on_signal() { trap - HUP INT TERM; exit 1; }");
    expect(prepareRelease).toContain("trap cleanup 0");
    expect(prepareRelease).toContain("trap on_signal HUP INT TERM");
    expect(prepareRelease).toContain('mv -f "$manifest_tmp" "$manifest"');
    expect(prepareRelease).toContain('if ! mkdir "$lock_dir"; then exit 1; fi');
    expect(prepareRelease).toContain('--iidfile "$image_id_file"');
    expect(prepareRelease).toContain('--entrypoint sh "$image_id"');
    expect(prepareRelease).not.toContain("claimgate:release");
    expect(prepareRelease).toContain("CLAIMGATE_REVISION");
    expect(verifyRelease).toContain("umask 022");
    expect(verifyRelease).toContain('"$runuser_command" -u claimgate --');
    expect(prepareRelease).not.toMatch(/sha256sum[^\n]*verify-release-artifacts/);
    expect(verifyRelease).toContain('if [ "$manifest_count" -ne 4 ]; then fail; fi');
    expect(verifyRelease).toContain('if [ -e "$app_dir" ]; then fail; fi');
    expect(verifyRelease).toContain('if [ -L "$app_dir" ]; then fail; fi');
    expect(verifyRelease).toContain('if [ -e "$runtime_dir" ]; then fail; fi');
    expect(verifyRelease).toContain('if [ -L "$runtime_dir" ]; then fail; fi');
    expect(verifyRelease).not.toMatch(/\]\s*&&\s*\[/);
    expect(deployment).toContain("REPLACE_WITH_DEPLOYMENT_HOST");
    expect(deployment).toContain("REPLACE_WITH_DEPLOYMENT_PORT");
    expect(deployment).toContain("REPLACE_WITH_DEPLOYMENT_USER");
    const executableShellFences = [...deployment.matchAll(/```(?:sh|shell)\s*\n([\s\S]*?)```/g)]
      .map((match) => match[1]);
    expect(executableShellFences).not.toEqual([]);
    expect(executableShellFences.join("\n")).not.toMatch(/<[^>\r\n]+>/);
    expect(deployController).toContain('"$ssh_command" -l "$deployment_user" -p "$deployment_port"');
    expect(deployController).toContain('< "$script_dir/verify-release-artifacts.sh"');
    expect(deployment).not.toContain('"$upload_dir/verify-release-artifacts.sh"');
    expect(deployment).not.toMatch(/docker cp\s+[^\n]*:\/app\s+/);
    expect(deployment).not.toContain("tar -tzf");
    expect(releaseContract).toContain("--no-same-owner --no-same-permissions");
    expect(deployment).not.toMatch(/curl[^\n]*\/api\/health/);
    expect(deployment).not.toContain("certbot --nginx");
    const addresses = deployment.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
    expect(new Set(addresses)).toEqual(new Set(["127.0.0.1"]));
    expect(deployment).not.toMatch(/(?:password|credential)\s*[:=]\s*\S+/i);
  });
});
