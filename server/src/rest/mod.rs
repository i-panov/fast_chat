mod middleware;
mod handlers;

use axum::{
    middleware::from_fn_with_state,
    routing::{get, post, put, delete},
    Router,
};
use std::sync::Arc;
use crate::AppState;

pub fn create_router(state: Arc<AppState>) -> Router {
    // Public routes
    let public = Router::new()
        .route("/api/health", get(handlers::health))
        .route("/api/auth/login", post(handlers::login));

    // Admin-only routes
    let admin = Router::new()
        // Users
        .route("/api/users", get(handlers::list_users))
        .route("/api/users", post(handlers::create_user))
        .route("/api/users/:id", put(handlers::update_user))
        .route("/api/users/:id", delete(handlers::delete_user))
        .route("/api/users/:id/admin", put(handlers::set_admin))
        .route("/api/users/:id/disable", put(handlers::set_disabled))
        // Server state
        .route("/api/stats", get(handlers::stats));

    // Apply JWT auth middleware to admin routes
    let admin = admin.layer(from_fn_with_state(state.clone(), middleware::auth_middleware));

    Router::new()
        .merge(public)
        .merge(admin)
        .with_state(state)
}
