// Talking to NEAR, with no wallet and no library beyond an ed25519 signer.
// A transaction is a small binary record, so building one here keeps the game
// light and lets the same signed bytes be offered to several RPC nodes: if one
// node is slow or rate-limited, a retry can never make a move happen twice.

import * as ed from "@noble/ed25519";

export const VALLEY = "kinlings.testnet";

/**
 * The valley's front door. This is not a secret, and it is meant to be public:
 * every visitor's browser needs it to open a farm. It is a testnet
 * function-call key on kinlings.testnet that NEAR only lets call
 * `open_account`, which the contract caps at 60 new farms an hour. It can't
 * move NEAR, sign anything else or touch any farm once it is open.
 */
export const FRONT_DOOR_KEY =
  "ed25519:4L5hxosd88XPc4tpa1L16NSXMMugXENdJHc8vw8WTjxYe7peaTKD9Dhr8BdMrqxwA4gc3kgAsX15JMZDgvoUUDmT";

const RPC_NODES = [
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.fastnear.com",
  "https://near-testnet.drpc.org",
];
/** Public nodes rate-limit. A node that refuses us is left alone for a while. */
const REST_MS = 20_000;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("Bad base58");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 255n));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ----- RPC ---------------------------------------------------------------

let preferredNode = 0;
const restingUntil = new Map<string, number>();

async function rpc(method: string, params: unknown): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RPC_NODES.length * 2; attempt++) {
    const node = RPC_NODES[(preferredNode + attempt) % RPC_NODES.length];
    const firstPass = attempt < RPC_NODES.length;
    if (firstPass && (restingUntil.get(node) ?? 0) > Date.now()) continue;
    if (!firstPass) await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      const response = await fetch(node, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "kinlings", method, params }),
      });
      if (response.status === 429 || response.status >= 500) {
        restingUntil.set(node, Date.now() + REST_MS);
        lastError = new Error(`${node} answered ${response.status}`);
        continue;
      }
      const body = await response.json();
      if (body.error) {
        const data = body.error.data ?? body.error.cause ?? body.error.message;
        if (typeof data === "string" && /UNKNOWN_|does not exist/.test(data)) throw new Error(data);
        if (body.error.cause?.name === "UNKNOWN_ACCOUNT") throw new Error("UNKNOWN_ACCOUNT");
        if (body.error.cause?.name === "UNKNOWN_ACCESS_KEY") throw new Error("UNKNOWN_ACCESS_KEY");
        lastError = new Error(JSON.stringify(body.error));
        continue;
      }
      preferredNode = (preferredNode + attempt) % RPC_NODES.length;
      return body.result;
    } catch (error) {
      if (error instanceof Error && /UNKNOWN_/.test(error.message)) throw error;
      restingUntil.set(node, Date.now() + REST_MS);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All RPC nodes failed");
}

/** Calls a read-only contract method and returns the parsed JSON answer. */
export async function view<T>(method: string, args: unknown): Promise<T> {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: VALLEY,
    method_name: method,
    args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args))),
  });
  if (result.error) throw new Error(result.error);
  const text = new TextDecoder().decode(Uint8Array.from(result.result as number[]));
  return JSON.parse(text) as T;
}

export async function accountExists(account: string): Promise<boolean> {
  try {
    await rpc("query", { request_type: "view_account", finality: "final", account_id: account });
    return true;
  } catch (error) {
    if (error instanceof Error && /UNKNOWN_ACCOUNT|does not exist/.test(error.message)) return false;
    throw error;
  }
}

export async function accountBalance(account: string): Promise<bigint> {
  const result = await rpc("query", { request_type: "view_account", finality: "final", account_id: account });
  return BigInt(result.amount);
}

export async function accountGlobalContract(account: string): Promise<string | null> {
  const result = await rpc("query", { request_type: "view_account", finality: "final", account_id: account });
  return result.global_contract_hash ?? null;
}

// ----- Transactions ------------------------------------------------------

class Writer {
  private chunks: number[] = [];

  u8(value: number) {
    this.chunks.push(value & 255);
  }

  u32(value: number) {
    for (let i = 0; i < 4; i++) this.chunks.push((value >>> (8 * i)) & 255);
  }

  u64(value: bigint) {
    for (let i = 0n; i < 8n; i++) this.chunks.push(Number((value >> (8n * i)) & 255n));
  }

  u128(value: bigint) {
    for (let i = 0n; i < 16n; i++) this.chunks.push(Number((value >> (8n * i)) & 255n));
  }

  bytes(value: Uint8Array) {
    this.chunks.push(...value);
  }

  string(value: string) {
    const encoded = new TextEncoder().encode(value);
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export interface Outcome {
  ok: boolean;
  error?: string;
  value?: unknown;
  hash: string;
  gasBurnt: number;
  tokensBurnt: bigint;
}

function readOutcome(result: any): Outcome {
  const outcomes = [result.transaction_outcome, ...(result.receipts_outcome ?? [])];
  let failure: unknown;
  let gasBurnt = 0;
  let tokensBurnt = 0n;
  for (const entry of outcomes) {
    gasBurnt += entry.outcome.gas_burnt as number;
    tokensBurnt += BigInt(entry.outcome.tokens_burnt);
    const status = entry.outcome.status;
    if (status && typeof status === "object" && "Failure" in status && !failure) failure = status.Failure;
  }
  const top = result.status;
  let value: unknown;
  if (top && typeof top === "object" && typeof top.SuccessValue === "string" && top.SuccessValue.length > 0) {
    try {
      value = JSON.parse(new TextDecoder().decode(fromBase64(top.SuccessValue)));
    } catch {
      value = undefined;
    }
  }
  return {
    ok: !failure && !(top && typeof top === "object" && "Failure" in top),
    error: failure ? JSON.stringify(failure) : undefined,
    value,
    hash: result.transaction_outcome.id,
    gasBurnt,
    tokensBurnt,
  };
}

/** A key this browser holds, able to sign for one account. */
export class Signer {
  readonly accountId: string;
  private seed: Uint8Array;
  private publicKey: Uint8Array | null = null;
  private nonce = 0n;
  /** One move at a time, so nonces always arrive in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(accountId: string, seed: Uint8Array) {
    this.accountId = accountId;
    this.seed = seed;
  }

  static async random(accountId: string): Promise<Signer> {
    return new Signer(accountId, crypto.getRandomValues(new Uint8Array(32)));
  }

  static fromNearSecret(accountId: string, secret: string): Signer {
    return new Signer(accountId, base58Decode(secret.replace("ed25519:", "")).slice(0, 32));
  }

  seedHex(): string {
    return toHex(this.seed);
  }

  async publicKeyBytes(): Promise<Uint8Array> {
    this.publicKey ??= await ed.getPublicKeyAsync(this.seed);
    return this.publicKey;
  }

  async publicKeyText(): Promise<string> {
    return "ed25519:" + base58Encode(await this.publicKeyBytes());
  }

  /** Runs moves strictly one after another. */
  call(receiver: string, method: string, args: unknown, tgas: number): Promise<Outcome> {
    const run = this.queue.then(() => this.send(receiver, method, args, tgas));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async refreshNonce(): Promise<string> {
    const key = await rpc("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: this.accountId,
      public_key: await this.publicKeyText(),
    });
    if (key.error) throw new Error(key.error);
    if (BigInt(key.nonce) > this.nonce) this.nonce = BigInt(key.nonce);
    return key.block_hash as string;
  }

  private async send(receiver: string, method: string, args: unknown, tgas: number): Promise<Outcome> {
    const blockHash = await this.refreshNonce();
    this.nonce += 1n;
    const signed = await this.sign(receiver, method, args, tgas, this.nonce, blockHash);
    const result = await rpc("send_tx", { signed_tx_base64: signed, wait_until: "EXECUTED_OPTIMISTIC" });
    return readOutcome(result);
  }

  private async sign(
    receiver: string,
    method: string,
    args: unknown,
    tgas: number,
    nonce: bigint,
    blockHash: string,
  ): Promise<string> {
    const writer = new Writer();
    writer.string(this.accountId);
    writer.u8(0);
    writer.bytes(await this.publicKeyBytes());
    writer.u64(nonce);
    writer.string(receiver);
    writer.bytes(base58Decode(blockHash));
    writer.u32(1);
    writer.u8(2); // FunctionCall
    writer.string(method);
    const encoded = new TextEncoder().encode(JSON.stringify(args));
    writer.u32(encoded.length);
    writer.bytes(encoded);
    writer.u64(BigInt(tgas) * 1_000_000_000_000n);
    writer.u128(0n);
    const transaction = writer.finish();

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", transaction as BufferSource));
    const signature = await ed.signAsync(digest, this.seed);

    const envelope = new Writer();
    envelope.bytes(transaction);
    envelope.u8(0);
    envelope.bytes(signature);
    return toBase64(envelope.finish());
  }
}

/** Signs a message with a raw seed. Used to prove a gift link was received. */
export async function signWithSeed(seedHex: string, message: string): Promise<string> {
  const signature = await ed.signAsync(new TextEncoder().encode(message), fromHex(seedHex));
  return toHex(signature);
}

export async function publicKeyHex(seedHex: string): Promise<string> {
  return toHex(await ed.getPublicKeyAsync(fromHex(seedHex)));
}
