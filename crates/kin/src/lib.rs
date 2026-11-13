//! The tiny contract every Kinling account runs.
//!
//! A Kinling is a real NEAR account with no access keys, so no person can ever
//! sign for it. It holds no state. It only obeys the valley contract, which it
//! finds by reading its own name: the valley is the last two parts of the
//! account id, as in `spark.flint.kinlings.testnet`.
//!
//! Only an account's direct parent can create its sub-accounts, so a baby can
//! only ever be born by its own mother's account. That is why the family tree
//! and the account tree are the same thing.
//!
//! The code is deployed once as a Global Contract (NEP-591). Every Kinling
//! points at it by hash, so a new creature costs no code storage, and nobody
//! can change what an existing creature does.

#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
mod contract {
    use near_sys as sys;

    const REGISTER: u64 = 0;
    const MAX_ID: usize = 64;
    const HASH_LEN: usize = 32;

    #[panic_handler]
    fn on_panic(_: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }

    fn fail(message: &str) -> ! {
        unsafe { sys::panic_utf8(message.len() as u64, message.as_ptr() as u64) }
    }

    fn read_register(buffer: &mut [u8]) -> usize {
        unsafe {
            let length = sys::register_len(REGISTER) as usize;
            if length > buffer.len() {
                fail("input too long");
            }
            sys::read_register(REGISTER, buffer.as_mut_ptr() as u64);
            length
        }
    }

    /// The last two labels of an account id.
    fn valley_part(id: &[u8]) -> &[u8] {
        let mut dots = 0;
        let mut i = id.len();
        while i > 0 {
            i -= 1;
            if id[i] == b'.' {
                dots += 1;
                if dots == 2 {
                    return &id[i + 1..];
                }
            }
        }
        id
    }

    /// Returns this account's id, after checking the caller is the valley.
    fn only_the_valley(me: &mut [u8; MAX_ID]) -> usize {
        let my_length = unsafe {
            sys::current_account_id(REGISTER);
            read_register(me)
        };
        let mut caller = [0u8; MAX_ID];
        let caller_length = unsafe {
            sys::predecessor_account_id(REGISTER);
            read_register(&mut caller)
        };
        if caller[..caller_length] != *valley_part(&me[..my_length]) {
            fail("only the valley can ask this");
        }
        my_length
    }

    /// Lays a baby account underneath this one.
    /// Input: the 32-byte contract hash, then the baby's short name.
    #[no_mangle]
    pub extern "C" fn spawn() {
        let mut me = [0u8; MAX_ID];
        let my_length = only_the_valley(&mut me);

        let mut input = [0u8; HASH_LEN + MAX_ID];
        let input_length = unsafe {
            sys::input(REGISTER);
            read_register(&mut input)
        };
        if input_length <= HASH_LEN {
            fail("missing name");
        }
        let (hash, name) = input[..input_length].split_at(HASH_LEN);

        let child_length = name.len() + 1 + my_length;
        if child_length > MAX_ID {
            fail("this family line has run out of room");
        }
        let mut child = [0u8; MAX_ID];
        child[..name.len()].copy_from_slice(name);
        child[name.len()] = b'.';
        child[name.len() + 1..child_length].copy_from_slice(&me[..my_length]);

        unsafe {
            let promise = sys::promise_batch_create(child_length as u64, child.as_ptr() as u64);
            sys::promise_batch_action_create_account(promise);
            sys::promise_batch_action_use_global_contract(
                promise,
                HASH_LEN as u64,
                hash.as_ptr() as u64,
            );
            sys::promise_return(promise);
        }
    }

    /// Sends NEAR that people gave this Kinling to its owner.
    /// Input: a 16-byte little-endian amount, then the recipient's account id.
    #[no_mangle]
    pub extern "C" fn release() {
        let mut me = [0u8; MAX_ID];
        only_the_valley(&mut me);

        let mut input = [0u8; 16 + MAX_ID];
        let input_length = unsafe {
            sys::input(REGISTER);
            read_register(&mut input)
        };
        if input_length <= 16 {
            fail("missing recipient");
        }
        let (amount, recipient) = input[..input_length].split_at(16);
        unsafe {
            let promise = sys::promise_batch_create(recipient.len() as u64, recipient.as_ptr() as u64);
            sys::promise_batch_action_transfer(promise, amount.as_ptr() as u64);
            sys::promise_return(promise);
        }
    }
}
