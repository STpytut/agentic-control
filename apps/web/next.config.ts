import path from "node:path";
import type { NextConfig } from "next";

const appDirectory = import.meta.dirname;
const monorepoRoot = path.resolve(appDirectory, "../..");

const nextConfig: NextConfig = {
  // `.next` by default. The route-authorization test starts a real panel, and a
  // second `next dev` on the same directory would otherwise contend for the same
  // build directory with whatever the developer already has running; the test
  // points this at a throwaway name instead.
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",

  // Self-hosted output. The panel is installed on the operator's own VPS from a
  // release tree, so the build has to produce a server that runs with nothing but
  // a Node binary: `next start` needs the dependency tree and a package manager's
  // layout, and installing either on the host at deploy time is what this avoids.
  output: "standalone",

  // A deterministic build id.
  //
  // Next generates one per build by default, and the value is not stable across two
  // builds of the same source: the two Linux release builds differed in
  // `BUILD_ID`, which changes the hashed directory under `.next/static` and, through
  // it, `build-manifest.json`, `middleware-build-manifest.js`, the `_buildManifest`,
  // `_ssgManifest` and `_clientMiddlewareManifest` files and every prerendered HTML
  // and RSC payload that references them — twenty-one files in all, and therefore
  // two different tarballs for one commit.
  //
  // The release builder already computes a value tied to the version and the commit
  // and passes it as `NEXT_BUILD_ID`; using it makes the two builds identical. The
  // fallback derives from the commit when git is available so a hand-run build is
  // stable too, and from a constant when it is not — never from the clock.
  generateBuildId: async () => {
    const explicit = process.env.NEXT_BUILD_ID?.trim();
    if (explicit) return explicit;
    try {
      const { execFileSync } = await import("node:child_process");
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: monorepoRoot, encoding: "utf8" }).trim();
      if (sha) return `infra-cod-${sha}`;
    } catch {
      // Not a checkout, or git is unavailable. Fall through to a constant rather
      // than a timestamp.
    }
    return "infra-cod-build";
  },

  // Traced from the monorepo root, not from `apps/web`. The standalone server
  // copies the files its requires resolve to, and this is a pnpm workspace: the
  // app's dependencies are linked out of the root store, so a trace rooted at
  // `apps/web` would miss everything reachable through a symlink and produce a
  // server that only fails once it is running on the target host.
  outputFileTracingRoot: monorepoRoot,

  // `pg` loads its own protocol and native binding modules at runtime, which a
  // bundler cannot follow. It has to stay a real `require` in the copied tree.
  serverExternalPackages: ["pg"],

  // The design system is a vendored workspace package (packages/agentic-design-system)
  // that ships TypeScript source, not a build: Next compiles it with the app.
  transpilePackages: ["@agentic/design-system"],

  // Caddy terminates every connection in front of this process and is the only
  // thing that talks to it, so announcing the server's identity adds a header no
  // client can use.
  poweredByHeader: false,

  // Compression belongs to Caddy too. It has the full response stream, the
  // `Accept-Encoding` header and the configured zstd/gzip policy; doing it twice
  // spends CPU to make the body marginally smaller.
  compress: false,
};

export default nextConfig;
