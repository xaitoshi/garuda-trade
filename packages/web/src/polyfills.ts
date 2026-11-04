import { Buffer } from "buffer";

// @solana/web3.js and spl-token read a global Buffer at import time, so this module is loaded by its own <script> in
// index.html BEFORE main.tsx (ES imports are hoisted: setting it inline in main.tsx would run after the Solana modules).
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
