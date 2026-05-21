import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

/**
 * @param {string} password
 * @returns {string}
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

/**
 * @param {string} password
 * @param {string|null|undefined} stored
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  if (!stored || typeof password !== "string") return false;
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  const derived = scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}
