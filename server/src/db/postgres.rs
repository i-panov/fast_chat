use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::time::Duration;

#[derive(Clone)]
pub struct PostgresPool {
    pool: PgPool,
}

impl PostgresPool {
    pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(20)
            .acquire_timeout(Duration::from_secs(10))
            .connect(database_url)
            .await?;

        Ok(Self { pool })
    }

    pub fn get_pool(&self) -> &PgPool {
        &self.pool
    }
}
