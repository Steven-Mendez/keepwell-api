/**
 * A lowercase v4 UUID. `crypto.randomUUID` only exists on secure origins (https, localhost), so a
 * phone opening the dev server by its LAN address builds one from `getRandomValues`, which works
 * everywhere.
 */
export function newID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * RFC 9562 name-based UUID (version 5, SHA-1). The same name always gives the same id on every
 * device and on the server, so an occurrence of a recurring rule or an installment of a loan
 * produced twice, in two places, is one row and sync merges it by itself. iOS computes the same
 * value with CryptoKit; `fixtures/ids.json` holds vectors that all three suites check.
 */
export function uuidV5(name: string, namespace: string = KEEPWELL_NAMESPACE): string {
  const ns = namespace.replace(/-/g, "")
  const bytes = new Uint8Array(16 + new TextEncoder().encode(name).length)
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16)
  bytes.set(new TextEncoder().encode(name), 16)
  const hash = sha1(bytes)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Keepwell's namespace for name-based ids: uuidV5("keepwell", the RFC's URL namespace). */
export const KEEPWELL_NAMESPACE = "b21aa395-c3f3-574c-b9a1-bf3e47f340c5"

/** The movement an occurrence of a recurring rule produces. The schedule is part of the name, so
 * editing it never makes a new occurrence collide with an old movement. */
export function occurrenceId(rule: { id: string; startDate: string; frequency: string; interval: number }, index: number): string {
  return uuidV5(`occurrence|${rule.id.toLowerCase()}|${rule.startDate}|${rule.frequency}|${rule.interval}|${index}`)
}

/** One installment of a loan: paying number 3 on two devices records one payment, not two. */
export function loanPaymentId(loanId: string, number: number): string {
  return uuidV5(`loan-payment|${loanId.toLowerCase()}|${number}`)
}

/** A repayment that predates repayment ids (old rows and backups), by what it was. */
export function legacyRepaymentId(debtId: string, index: number, date: string, amount: string): string {
  return uuidV5(`debt-repayment|${debtId.toLowerCase()}|${index}|${date}|${amount}`)
}

/** Plain SHA-1, synchronous (Web Crypto's is async). Only for name-based ids, never for security. */
function sha1(message: Uint8Array): Uint8Array {
  const length = message.length
  const words = new Uint32Array((((length + 8) >> 6) + 1) * 16)
  for (let i = 0; i < length; i++) words[i >> 2]! |= message[i]! << (24 - (i % 4) * 8)
  words[length >> 2]! |= 0x80 << (24 - (length % 4) * 8)
  words[words.length - 1] = length * 8
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  const w = new Uint32Array(80)
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[block + t]!
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!
      w[t] = (x << 1) | (x >>> 31)
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4]
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]!) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  ;[h0, h1, h2, h3, h4].forEach((h, i) => {
    out[i * 4] = h >>> 24
    out[i * 4 + 1] = (h >>> 16) & 0xff
    out[i * 4 + 2] = (h >>> 8) & 0xff
    out[i * 4 + 3] = h & 0xff
  })
  return out
}
