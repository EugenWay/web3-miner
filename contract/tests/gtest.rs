use robo_miner_profile_client::{
    RoboMinerProfileClient, RoboMinerProfileClientCtors, robo_miner_profile::*,
};
use sails_rs::{client::*, gtest::*};

const ACTOR_ID: u64 = 42;

#[tokio::test]
async fn do_something_works() {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    system.mint_to(ACTOR_ID, 100_000_000_000_000);
    // Submit program code into the system
    let program_code_id = system.submit_code(robo_miner_profile::WASM_BINARY);

    // Create Sails Env
    let env = GtestEnv::new(system, ACTOR_ID.into());

    let program = env
        .deploy::<robo_miner_profile_client::RoboMinerProfileClientProgram>(
            program_code_id,
            b"salt".to_vec(),
        )
        .create() // Call program's constructor
        .await
        .unwrap();

    let mut service_client = program.robo_miner_profile();

    let result = service_client
        .do_something() // Call service's method
        .await
        .unwrap();

    assert_eq!(result, "Hello from RoboMinerProfile!".to_string());
}
