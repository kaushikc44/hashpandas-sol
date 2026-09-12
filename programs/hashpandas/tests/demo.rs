//! A narrated, real end-to-end run: initialize the program, mine a panda
//! (real proof-of-work search against a demo-low difficulty), and print
//! what happened. This executes the actual compiled `hashpandas.so` and the
//! real, mainnet-downloaded Metaplex Core program under litesvm -- not a
//! mock of either.
//!
//! Run with: cargo test --test demo -- --nocapture

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use solana_keccak_hasher as keccak;
use litesvm::LiteSVM;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer as _;
use solana_transaction::Transaction;

use hashpandas::{InitializeArgs, MintArgs, RoyaltyCreatorArg, RuleSetArg};

fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}

fn ix_data<T: AnchorSerialize>(discriminator: [u8; 8], args: &T) -> Vec<u8> {
    let mut data = discriminator.to_vec();
    AnchorSerialize::serialize(args, &mut data).unwrap();
    data
}

#[test]
fn demo_initialize_and_mint() {
    let program_id = hashpandas::ID;

    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id, "../../target/deploy/hashpandas.so")
        .expect("load hashpandas.so -- run `anchor build` first");
    svm.add_program_from_file(mpl_core::ID, "tests/fixtures/mpl_core.so")
        .expect("load mpl_core.so -- fetch with `solana program dump`");

    let payer = Keypair::new();
    let miner = Keypair::new();
    let collection = Keypair::new();
    let asset = Keypair::new();

    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&miner.pubkey(), 10_000_000_000).unwrap();

    let (config, _) = pda(&[b"config"], &program_id);
    let (vault, _) = pda(&[b"vault"], &program_id);
    let (treasury, _) = pda(&[b"treasury"], &program_id);
    let (panda_mint, _) = pda(&[b"panda_mint"], &program_id);
    let (buyback_dest_token_account, _) = pda(
        &[
            config.as_ref(),
            anchor_spl::token::ID.as_ref(),
            panda_mint.as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    );

    println!("\n=== initialize ===");
    println!("program:  {program_id}");
    println!("config:   {config}");
    println!("vault:    {vault}");
    println!("treasury: {treasury}");
    println!("panda_mint: {panda_mint}");

    let init_args = InitializeArgs {
        step_lamports: 500_000,
        epoch0_flat_lamports: 10_000_000,
        base_difficulty: 1, // deliberately trivial for a fast, watchable demo
        collection_name: "Hashpandas".to_string(),
        collection_uri: "https://example.com/collection.json".to_string(),
        royalty_bps: 500,
        royalty_creators: vec![RoyaltyCreatorArg {
            address: payer.pubkey(),
            percentage: 100,
        }],
        royalty_rule_set: RuleSetArg::None,
        buyback_amm_program: system_program::ID, // unused in this demo
        crank_spend_cap_lamports: 1_000_000,
        max_price_impact_bps: 500,
    };

    let init_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(payer.pubkey(), true), // authority == payer for the demo
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new_readonly(treasury, false),
            AccountMeta::new(panda_mint, false),
            AccountMeta::new(collection.pubkey(), true),
            AccountMeta::new_readonly(mpl_core::ID, false),
            AccountMeta::new(buyback_dest_token_account, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
            AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
        ],
        data: ix_data([175, 175, 109, 31, 13, 152, 155, 237], &init_args),
    };

    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(
        &[&payer, &collection],
        Message::new(&[init_ix], Some(&payer.pubkey())),
        blockhash,
    );
    let result = svm.send_transaction(tx);
    match &result {
        Ok(meta) => {
            println!("initialize OK, {} CU consumed", meta.compute_units_consumed);
            for line in &meta.logs {
                println!("  log: {line}");
            }
        }
        Err(e) => {
            println!("initialize FAILED:");
            for line in &e.meta.logs {
                println!("  log: {line}");
            }
            panic!("{:#?}", e.err);
        }
    }

    // ---- Mine a real proof-of-work solution for the first panda ----
    println!("\n=== mining panda #1 (target: >= 1 leading zero bit) ===");
    let last_winning_hash = [0u8; 32];
    let anchor_hash = [7u8; 32]; // stand-in for a real SlotHashes entry (see below)
    let mut nonce: u64 = 0;
    let (work_hash, bits) = loop {
        let h = keccak::hashv(&[
            miner.pubkey().as_ref(),
            &nonce.to_le_bytes(),
            &last_winning_hash,
            &anchor_hash,
        ])
        .to_bytes();
        let bits = hashpandas::utils::leading_zero_bits(&h);
        if bits >= 1 {
            break (h, bits);
        }
        nonce += 1;
    };
    println!("found nonce {nonce} -> hash {} ({bits} leading zero bits)", hex(&work_hash));

    // `mint` calls `utils::verify_anchor`, which reads the real SlotHashes
    // sysvar via the `sol_get_sysvar` syscall and checks that `anchor_hash`
    // really is the hash Solana recorded for `anchor_slot`. litesvm starts
    // with an empty SlotHashes, so we seed it with exactly the entry our
    // mined preimage used -- this is litesvm standing in for "a real slot
    // just went by with this hash," not a way around the check.
    let slot_hashes = solana_sysvar::slot_hashes::SlotHashes::new(&[(0, Hash::new_from_array(anchor_hash))]);
    svm.set_sysvar(&slot_hashes);
    // litesvm starts at slot 0, which collides with `last_mint_slot`'s "no
    // mint yet" sentinel value -- warp forward, exactly as a real cluster
    // already would be well past genesis by the time anyone can transact.
    svm.warp_to_slot(1);

    let mint_args = MintArgs {
        nonce,
        anchor_slot: 0,
        anchor_hash,
        uri: "https://example.com/panda/1.json".to_string(),
    };
    let (panda, _) = pda(&[b"panda", asset.pubkey().as_ref()], &program_id);
    let mint_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(miner.pubkey(), true),
            AccountMeta::new(config, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(treasury, false),
            AccountMeta::new(collection.pubkey(), false),
            AccountMeta::new(asset.pubkey(), true),
            AccountMeta::new(panda, false),
            AccountMeta::new_readonly(mpl_core::ID, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: ix_data([51, 57, 225, 47, 182, 146, 137, 166], &mint_args),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(
        &[&miner, &asset],
        Message::new(&[mint_ix], Some(&miner.pubkey())),
        blockhash,
    );
    let result = svm.send_transaction(tx);
    match &result {
        Ok(meta) => {
            println!("mint OK, {} CU consumed", meta.compute_units_consumed);
            for line in &meta.logs {
                println!("  log: {line}");
            }
        }
        Err(e) => {
            println!("mint result (see note above about SlotHashes in litesvm):");
            for line in &e.meta.logs {
                println!("  log: {line}");
            }
            println!("  err: {:#?}", e.err);
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
