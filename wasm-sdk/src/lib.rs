mod crypto;
mod error;
mod generated;

pub use crypto::CryptoService;
pub use error::CryptoError;
pub use generated::client::GrpcClient;
pub use generated::types::*;

use wasm_bindgen::prelude::*;

/// Initialize the WASM module (call once on startup)
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    tracing_wasm::set_as_global_default();
}
