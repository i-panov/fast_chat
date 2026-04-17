//! Domain layer — pure business entities without framework dependencies.
//! 
//! Unlike `models/` which contains SQLx-generated types bound to the database,
//! `domain/` contains application-level types that represent business concepts.

pub mod user;
pub mod chat;
pub mod message;
