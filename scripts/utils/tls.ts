/**
 * TLS certificate helper for Windows environments.
 *
 * On some Windows machines the native certificate store is incomplete or
 * inaccessible, causing `rustls-native-certs` (used by the Stellar CLI)
 * to fail with:
 *   - "could not load platform certs" (panic)
 *   - "invalid peer certificate: UnknownIssuer"
 *
 * This module downloads the Mozilla CA bundle once and sets SSL_CERT_FILE
 * so rustls can verify TLS connections.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CA_BUNDLE_URL = "https://curl.se/ca/cacert.pem";
const CA_BUNDLE_PATH = join(tmpdir(), "cacert.pem");

/**
 * Ensure a valid CA bundle is available and SSL_CERT_FILE points to it.
 * Safe to call multiple times — the download is skipped if already cached.
 */
export async function ensureTlsCerts(): Promise<void> {
    if (!existsSync(CA_BUNDLE_PATH)) {
        console.log("📥 Downloading Mozilla CA certificate bundle...");
        try {
            const res = await fetch(CA_BUNDLE_URL);
            if (res.ok) {
                await Bun.write(CA_BUNDLE_PATH, await res.text());
                console.log(`✅ CA bundle saved to ${CA_BUNDLE_PATH}`);
            } else {
                console.warn(
                    `⚠️  Failed to download CA bundle (${res.status}), continuing with system certs...`
                );
            }
        } catch {
            console.warn(
                "⚠️  Failed to download CA bundle, continuing with system certs..."
            );
        }
    }

    if (existsSync(CA_BUNDLE_PATH)) {
        process.env.SSL_CERT_FILE = CA_BUNDLE_PATH;
    } else {
        delete process.env.SSL_CERT_FILE;
    }
    delete process.env.SSL_CERT_DIR;
    delete process.env.REQUESTS_CA_BUNDLE;
}
