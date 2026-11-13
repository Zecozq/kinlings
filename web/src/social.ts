// NEAR Social (near.social): a player's own mainnet account, linked to their farm.
//
// Reading is open to everyone through the near.social API. Writing is a NEAR
// transaction to the account `social`, signed in the player's own mainnet
// wallet, and only ever when they press a button: linking their farm to their
// profile, or posting words they can see and edit first. Kinlings never posts
// on anyone's behalf.
//
// The link is checked from both sides: the farm says which NEAR Social account
// it is (`set_social` on the valley), and the NEAR Social profile names the
// farm (`profile/links/kinlings`). Only the owner of each can write their side,
// so when the two agree the link is real.

const API = "https://api2.near.social";
const STORAGE = "kinlings.social.v1";
/** The writes cost almost nothing: the `social` account has no contract to run. */
const WRITE_GAS = "1000000000";
export const LINK_KEY = "kinlings";

type Connector = import("@hot-labs/near-connect").NearConnector;

export interface SocialProfile {
  accountId: string;
  name: string | null;
  avatarUrl: string | null;
  links: Record<string, string>;
  followers: number;
}

let connector: Connector | null = null;
let account: string | null = readSaved();
const profiles = new Map<string, Promise<SocialProfile | null>>();

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

/** Kept apart from the testnet wallet's own choice of wallet. */
function prefixedStorage(prefix: string) {
  return {
    async get(key: string) {
      try {
        return localStorage.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    async set(key: string, value: string) {
      try {
        localStorage.setItem(prefix + key, value);
      } catch {
        // Nothing to do: the picker shows again next time.
      }
    },
    async remove(key: string) {
      try {
        localStorage.removeItem(prefix + key);
      } catch {
        // As above.
      }
    },
  };
}

async function getConnector(): Promise<Connector> {
  if (connector) return connector;
  const { NearConnector } = await import("@hot-labs/near-connect");
  const created = new NearConnector({
    network: "mainnet",
    features: { signAndSendTransaction: true },
    storage: prefixedStorage("kinlings.social.connector."),
  });
  created.on("wallet:signOut", () => remember(null));
  created.on("wallet:signIn", (event) => remember(event.accounts[0]?.accountId ?? null));
  connector = created;
  return created;
}

/** The NEAR Social (mainnet) account connected in this browser, if any. */
export function socialAccount(): string | null {
  return account;
}

/** Shows the wallet picker for a NEAR mainnet account. */
export async function connectSocial(): Promise<string | null> {
  const active = await getConnector();
  const wallet = await active.connect();
  const accounts = await wallet.getAccounts({ network: "mainnet" });
  remember(accounts[0]?.accountId ?? null);
  return account;
}

export async function disconnectSocial(): Promise<void> {
  if (connector) await connector.disconnect().catch(() => undefined);
  remember(null);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`near.social said ${response.status}`);
  return (await response.json()) as T;
}

/** A NEAR Social profile, read from the public API. Cached for the session. */
export function profileOf(accountId: string, fresh = false): Promise<SocialProfile | null> {
  if (!fresh && profiles.has(accountId)) return profiles.get(accountId)!;
  const loading = getJson<any>(`/v1/accounts/${encodeURIComponent(accountId)}`)
    .then((raw) => ({
      accountId: raw.account_id ?? accountId,
      name: raw.name ?? null,
      avatarUrl: raw.avatar_url ?? null,
      links: raw.links ?? {},
      followers: raw.counts?.followers ?? 0,
    }))
    .catch((error) => {
      console.warn("Could not read that NEAR Social profile", error);
      profiles.delete(accountId);
      return null;
    });
  profiles.set(accountId, loading);
  return loading;
}

/** Who an account follows on NEAR Social, newest first. */
export async function followingOf(accountId: string, most = 300): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: { account_id: string }[]; next_cursor: string | null } = await getJson(
      `/v1/accounts/${encodeURIComponent(accountId)}/following?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    found.push(...page.items.map((item) => item.account_id));
    cursor = page.next_cursor;
  } while (cursor && found.length < most);
  return found.slice(0, most);
}

/** True when a NEAR Social profile names this farm, so the link is real from both sides. */
export async function linkVerified(social: string, farmAccount: string): Promise<boolean> {
  const found = await profileOf(social);
  return found?.links?.[LINK_KEY] === farmAccount;
}

/**
 * Writes to NEAR Social from the connected mainnet wallet. The receipt always
 * reports a failure, because `social` has no contract: that is how NEAR Social
 * works, and the data is still indexed. So a "failure" from the wallet isn't
 * trusted either way. Callers check the result by reading it back.
 */
async function writeSocial(data: Record<string, unknown>): Promise<void> {
  if (!account) await connectSocial();
  if (!account) throw new Error("No NEAR Social account connected");
  const active = await getConnector();
  const wallet = await active.wallet();
  try {
    await wallet.signAndSendTransaction({
      signerId: account,
      receiverId: "social",
      actions: [{ type: "FunctionCall", params: { methodName: "__fastdata_kv", args: data, gas: WRITE_GAS, deposit: "0" } }],
    });
  } catch (error) {
    // Expected: the receipt "fails" by design. A refusal in the wallet looks
    // the same here, which is why the caller reads the result back.
    console.info("NEAR Social write finished with", error);
  }
}

async function until(check: () => Promise<boolean>, seconds = 20): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

/** Writes this farm into the player's NEAR Social profile, and waits to see it there. */
export async function linkFarmOnSocial(farmAccount: string): Promise<boolean> {
  await writeSocial({ [`profile/links/${LINK_KEY}`]: farmAccount });
  const social = account!;
  return until(async () => (await profileOf(social, true))?.links?.[LINK_KEY] === farmAccount);
}

/** Posts the player's own words to NEAR Social, and waits until it shows. */
export async function postOnSocial(text: string): Promise<boolean> {
  const id = String(Date.now());
  await writeSocial({ [`post/${id}`]: { text } });
  const social = account!;
  return until(async () => {
    // Each item wraps its post, so reposts can be told apart.
    const posts: { items: { id?: string; post?: { id: string } }[] } = await getJson(`/v1/accounts/${encodeURIComponent(social)}/posts?limit=5`);
    return posts.items.some((item) => (item.post?.id ?? item.id) === id);
  });
}

/** Where a NEAR Social account's page is. */
export function socialUrl(accountId: string): string {
  return `https://near.social/${encodeURIComponent(accountId)}`;
}
