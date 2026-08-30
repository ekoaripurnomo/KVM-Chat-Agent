import { randomInt } from 'node:crypto';

// Ambiguous characters (0/O, 1/l/I) removed for readability.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SYMBOLS = '!@#%^&*-_=+';

/** Generate a readable but strong password (letters+digits+one symbol). */
export function generatePassword(length = 16): string {
  const chars: string[] = [];
  for (let i = 0; i < length - 1; i++) {
    chars.push(ALPHABET[randomInt(ALPHABET.length)]);
  }
  // Guarantee at least one symbol, placed at a random position.
  chars.splice(randomInt(chars.length + 1), 0, SYMBOLS[randomInt(SYMBOLS.length)]);
  return chars.join('');
}

/**
 * Derive a valid Linux username from a VM name: lowercase, strip invalid chars,
 * ensure it starts with a letter. Falls back to "ubuntu".
 */
export function usernameFromVmName(vmName: string): string {
  let u = vmName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  u = u.replace(/^[^a-z_]+/, ''); // must start with letter/underscore
  return u.length >= 1 ? u.slice(0, 32) : 'ubuntu';
}
