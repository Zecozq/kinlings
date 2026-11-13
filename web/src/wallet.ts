// A player's own NEAR wallet. The farm account pays for everyday moves by
// itself, so the wallet is for NEAR that matters: being paid race prizes, hire
// fees and stall sales, and paying for hires, challenges and stall goods.
// The connector is loaded the first time someone asks for it.

import { VALLEY } from "./chain.ts";

type Connector = import("@hot-labs/near-connect").NearConnector;

const STORAGE = "kinlings.wallet.v1";
const YOCTO_PER_MILLI = 1_000_000_000_000_000_000_000n;
const HIRE_GAS = "60000000000000";

let connector: Connector | null = null;
let account: string | null = readSaved();

function readSaved(): string | null {
  try {
    return localStorage.getItem(STORAGE);
  } catch {
    return null;
  }
}

function remember(next: string | null) {
  account = next;
  try {
    if (next) localStorage.setItem(STORAGE, next);
    else localStorage.removeItem(STORAGE);
  } catch {
    // Only a convenience: the wallet is asked again next time.
  }
}

async function getConnector(): Promise<Connector> {
  if (connector) return connector;
  const { NearConnector } = await import("@hot-labs/near-connect");
  const created = new NearConnector({ network: "testnet", features: { signAndSendTransaction: true, testnet: true } });
  created.on("wallet:signOut", () => remember(null));
  created.on("wallet:signIn", (event) => remember(event.accounts[0]?.accountId ?? null));
  connector = created;
  return created;
}

/** The connected wallet's account name, if there is one. */
export function walletAccount(): string | null {
  return account;
}

/** Shows the wallet picker. Resolves with the account once one is connected. */
export async function connectWallet(): Promise<string | null> {
  const active = await getConnector();
  const wallet = await active.connect();
  const accounts = await wallet.getAccounts({ network: "testnet" });
  remember(accounts[0]?.accountId ?? null);
  return account;
}

export async function disconnectWallet(): Promise<void> {
  if (connector) await connector.disconnect().catch(() => undefined);
  remember(null);
}

/** Calls the valley from the connected wallet, with NEAR attached. */
export async function callWithWallet(methodName: string, args: object, milli: number, gas = HIRE_GAS): Promise<void> {
  if (!account) await connectWallet();
  if (!account) throw new Error("No wallet connected");
  const active = await getConnector();
  const wallet = await active.wallet();
  await wallet.signAndSendTransaction({
    signerId: account,
    receiverId: VALLEY,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName, args, gas, deposit: (BigInt(milli) * YOCTO_PER_MILLI).toString() },
      },
    ],
  });
}

/** Pays for a hire from the connected wallet, on behalf of this farm. */
export function payHireWithWallet(kinId: number, milli: number, farmer: string): Promise<void> {
  return callWithWallet("rent_kin", { kin_id: kinId, farmer }, milli);
}

/** Opens a challenge, paying the fee from the connected wallet, for this farm. */
export function openChallengeWithWallet(kinId: number, feeMilli: number, seats: number, farmer: string): Promise<void> {
  return callWithWallet("open_challenge", { kin_id: kinId, fee_milli: feeMilli, seats, farmer }, feeMilli);
}

export function joinChallengeWithWallet(challenge: number, kinId: number, feeMilli: number, farmer: string): Promise<void> {
  return callWithWallet("join_challenge", { challenge, kin_id: kinId, farmer }, feeMilli);
}

/** Buys from a stall priced in NEAR, from the connected wallet, for this farm. */
export function buyListingWithWallet(listing: number, quantity: number, milli: number, farmer: string): Promise<void> {
  return callWithWallet("buy_listing_near", { listing, quantity, farmer }, milli);
}
