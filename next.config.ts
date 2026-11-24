import type { NextConfig } from "next";

/**
 * Cache Components is intentionally disabled: every screen in this application is
 * per-user and permission-scoped, so classic dynamic rendering is simpler and
 * safer (no risk of caching one user's authorized data for another).
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // geolocation=(self): optional, user-initiated GPS stamping of site evidence (GRN photos).
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Browsers ignore HSTS over plain HTTP, so this is inert in local dev and only takes
  // effect once the app is served over HTTPS (Vercel / Nginx + TLS).
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  poweredByHeader: false,
  // Dev-server logging of Server Function arguments would print passwords (login,
  // change/reset password, temporary member passwords) to the terminal. Never log them.
  logging: { serverFunctions: false },
  output: "standalone",
  // PDF routes read the bundled fonts (₹ glyph) and the standard logo from disk at runtime;
  // standalone output only copies traced files, so include them explicitly.
  outputFileTracingIncludes: {
    "/api/help/manual": ["./docs/user-guide/*.pdf", "./docs/user-guide/*.docx"],
    "/api/documents/pdf": ["./src/assets/fonts/**/*", "./public/logo1.png"],
    "/api/reports/pdf": ["./src/assets/fonts/**/*", "./public/logo1.png"],
  },
  // Native / worker-resolving packages must not be bundled by Turbopack.
  serverExternalPackages: ["@node-rs/argon2", "@react-pdf/renderer", "pg", "embedded-postgres"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
