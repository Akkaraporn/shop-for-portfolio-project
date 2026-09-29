// Generates the argon2id PHC strings embedded in V2__seed.sql.
//
// Kept in the repo so the seed's hashes are reproducible rather than magic, but
// it is not part of the build: run it by hand only if the demo password changes.
//   node migrations/.gen-seed-hashes.mjs
//
// Parameters are OWASP's argon2id recommendation and must match what the auth
// module uses at runtime (task 2.2), or these seeded users cannot log in.
import { argon2Sync, randomBytes } from "node:crypto";

const MEMORY = 19456; // KiB
const PASSES = 2;
const PARALLELISM = 1;
const TAG_LENGTH = 32;

const DEMO_PASSWORD = "DemoPass123!";
const EMAILS = [
  "admin@vibecode.shop",
  "somchai@example.com",
  "pimchanok@example.com",
];

const b64 = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "");

function hash(password) {
  const salt = randomBytes(16);
  const tag = argon2Sync("argon2id", {
    message: Buffer.from(password, "utf8"),
    nonce: salt,
    memory: MEMORY,
    passes: PASSES,
    parallelism: PARALLELISM,
    tagLength: TAG_LENGTH,
  });
  const params = `m=${MEMORY},t=${PASSES},p=${PARALLELISM}`;
  return ["", "argon2id", "v=19", params, b64(salt), b64(tag)].join("$");
}

for (const email of EMAILS) {
  console.log(`${email}\t${hash(DEMO_PASSWORD)}`);
}
