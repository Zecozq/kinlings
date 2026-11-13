// Google or email sign-in through NEAR Auth. The login derives a NEAR key held
// by NEAR's MPC network, so no seed phrase ever exists. That key owns the
// player's account, and a limited key in the browser plays the game.
//
// Testnet's shared login client only accepts http://localhost:3000. A hosted
// copy of the game needs its own client id in VITE_KINLINGS_AUTH_CLIENT.

const SHARED_TESTNET_CLIENT = "np8paqIpMWmNbzT4xAvOOapZBjsOpptl";
const NODE_URL = "https://rpc.testnet.near.org";
const PENDING_NAME = "kinlings.pending-name";
const ownClient: string | undefined = import.meta.env.VITE_KINLINGS_AUTH_CLIENT;

export function loginAvailable(): boolean {
  return Boolean(ownClient) || location.origin === "http://localhost:3000";
}

async function connectAuth() {
  // These libraries expect two Node globals, and only load if someone signs in.
  const { Buffer } = await import("buffer");
  const globals = globalThis as { Buffer?: unknown; global?: unknown };
  globals.Buffer ??= Buffer;
  globals.global ??= globalThis;
  const [{ FastAuthClient }, { JavascriptProvider }, { connect }] = await Promise.all([
    import("@fast-auth-near/browser-sdk"),
    import("@fast-auth-near/javascript-provider"),
    import("near-api-js"),
  ]);
  const provider = new JavascriptProvider({ network: "testnet", clientId: ownClient ?? SHARED_TESTNET_CLIENT });
  const { connection } = await connect({ networkId: "testnet", nodeUrl: NODE_URL });
  const client = new FastAuthClient(provider, connection, {
    fastAuthContractId: "fast-auth.testnet",
    mpcContractId: "v1.signer-prod.testnet",
  });
  return { client, provider };
}

/** Leaves for the login page. The player comes back through `finishLogin`. */
export async function beginLogin(name: string): Promise<void> {
  sessionStorage.setItem(PENDING_NAME, name);
  const { client } = await connectAuth();
  await client.login({ redirectUri: location.origin });
}

export function returningFromLogin(): boolean {
  const query = new URLSearchParams(location.search);
  return query.has("code") && query.has("state") && sessionStorage.getItem(PENDING_NAME) !== null;
}

/** Finishes the login, returning the chosen name and the login's NEAR key. */
export async function finishLogin(): Promise<{ name: string; identity: string }> {
  const { client, provider } = await connectAuth();
  const loggedIn = await provider.isLoggedIn();
  history.replaceState(null, "", location.pathname);
  if (!loggedIn) throw new Error("The sign-in did not finish");
  const signer = await client.getSigner();
  const key = await signer.getPublicKey();
  const name = sessionStorage.getItem(PENDING_NAME) ?? "Farmer";
  sessionStorage.removeItem(PENDING_NAME);
  return { name, identity: key.toString() };
}
