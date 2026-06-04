## The **robo-miner-profile** program

[![Build Status](https://github.com/gear-tech/robo-miner-profile/workflows/CI/badge.svg)](https://github.com/gear-tech/robo-miner-profile/actions)

Program **robo-miner-profile** for [⚙️ Gear Protocol](https://github.com/gear-tech/gear) written in [⛵ Sails](https://github.com/gear-tech/sails) framework.

The program workspace includes the following packages:
- `robo-miner-profile` is the package allowing to build WASM binary for the program and IDL file for it.
  The package also includes integration tests for the program in the `tests` sub-folder
- `robo-miner-profile-app` is the package containing business logic for the program represented by the `RoboMinerProfile` structure.
- `robo-miner-profile-client` is the package containing the client for the program allowing to interact with it from another program, tests, or off-chain client.

### 🏗️ Building

```bash
cargo build --release
```

### ✅ Testing

```bash
cargo test --release
```

# License

The source code is licensed under the [MIT license](LICENSE).
